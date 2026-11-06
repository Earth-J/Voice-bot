/**
 * Audio pipeline: per-speaker opus stream → PCM → periodic-flush sub-chunks → WAV.
 *
 * Each time Discord's voice receiver reports "speaking start" for a user, we
 * open an opus subscription that auto-ends after configured silence. The opus
 * frames get decoded to PCM (48kHz stereo s16le) by prism.opus.Decoder, then
 * piped to an in-memory buffer.
 *
 * Strategy (long-talk safe):
 *   - Keep the opus stream OPEN until actual silence (no force-destroy at maxMs)
 *   - Every `chunkFlushMs` ms, snapshot current buffer → encode WAV → dispatch
 *     to onChunk, then reset buffer and continue capturing
 *   - On stream 'end' (silence reached): final flush + onComplete callback
 *
 * This avoids the "lost audio after 30s" bug where destroying the stream
 * mid-utterance dropped frames until Discord re-emitted "speaking start".
 */
import { EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import prism from "prism-media";

const TMP_DIR = process.env.VOICE_TMP_DIR || join(tmpdir(), "voice-bot-stt");
const FFMPEG_BIN: string =
  process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string) || "ffmpeg";

export interface AudioChunk {
  userId: string;
  wavPath: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  byteSize: number;
  /** true if this chunk was a periodic flush (stream still open afterwards). */
  isPartial?: boolean;
}

export type ChunkHandler = (chunk: AudioChunk) => Promise<void> | void;

export interface PipelineConfig {
  /** Stream auto-ends after this ms of silence (default 1500). */
  silenceThresholdMs: number;
  /**
   * @deprecated ignored — chunks no longer force-destroy at this boundary.
   * Use chunkFlushMs instead.
   */
  maxChunkMs?: number;
  /** Snapshot interval for in-flight long utterances (default 8000ms). */
  chunkFlushMs?: number;
  /**
   * Final chunks (stream-end flush) shorter than this are dropped without
   * transcription — whisper hallucinates on tiny noise-only chunks, producing
   * fake "UPS โรงเรียน..." / "ขอบคุณที่ติดตาม" / etc. Real utterances longer
   * than this are preserved. Default 1500ms.
   *
   * Partial (mid-utterance) flushes are NEVER dropped — they're streaming
   * snapshots that will get more audio appended on the next flush cycle.
   */
  minFinalChunkMs?: number;
}

const PCM_RATE = 48_000;
const PCM_CHANNELS = 2;
const PCM_FRAME_SIZE = 960;

export function startSpeakerCapture(
  connection: VoiceConnection,
  userId: string,
  config: PipelineConfig,
  onChunk: ChunkHandler,
  onComplete?: () => void,
): void {
  mkdirSync(TMP_DIR, { recursive: true });

  const receiver = connection.receiver;
  const opusStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: config.silenceThresholdMs,
    },
  });

  const pcmDecoder = new prism.opus.Decoder({
    rate: PCM_RATE,
    channels: PCM_CHANNELS,
    frameSize: PCM_FRAME_SIZE,
  });

  const pcmStream = opusStream.pipe(pcmDecoder);
  let buffers: Buffer[] = [];
  let subChunkStartedAt = Date.now();
  let flushSeq = 0;
  let flushing = false;
  let ended = false;

  const flushIntervalMs = config.chunkFlushMs ?? 8_000;
  const minFinalChunkMs = config.minFinalChunkMs ?? 1_500;

  const dispatchBuffer = async (isPartial: boolean): Promise<void> => {
    if (buffers.length === 0) return;
    if (flushing) return; // skip overlap; will pick up next tick
    flushing = true;
    const pcm = Buffer.concat(buffers);
    buffers = [];
    const startedAt = subChunkStartedAt;
    const endedAt = Date.now();
    subChunkStartedAt = endedAt;
    flushSeq++;
    const durationMs = endedAt - startedAt;
    // Drop final chunks shorter than minFinalChunkMs — whisper hallucinates on
    // tiny noise-only audio (e.g. "UPS โรงเรียน..."). Partial chunks (mid-utterance
    // snapshots) are always kept since more audio is coming.
    if (!isPartial && durationMs < minFinalChunkMs) {
      console.log(
        `[audio] drop short final chunk user=${userId} dur=${durationMs}ms < ${minFinalChunkMs}ms`,
      );
      flushing = false;
      return;
    }
    const wavPath = join(
      TMP_DIR,
      `${startedAt}_${userId}_p${flushSeq}.wav`,
    );
    try {
      await encodeWav(pcm, wavPath);
      const chunk: AudioChunk = {
        userId,
        wavPath,
        startedAt,
        endedAt,
        durationMs,
        byteSize: pcm.length,
        isPartial,
      };
      await onChunk(chunk);
    } catch (e: any) {
      console.warn(
        `[audio] encode/handle failed user=${userId} seq=${flushSeq}:`,
        e?.message ?? e,
      );
    } finally {
      flushing = false;
    }
  };

  const flushTimer = setInterval(() => {
    if (ended) return;
    void dispatchBuffer(true);
  }, flushIntervalMs);

  pcmStream.on("data", (chunk: Buffer) => {
    buffers.push(chunk);
  });

  pcmStream.on("end", async () => {
    ended = true;
    clearInterval(flushTimer);
    // Wait for any in-flight flush, then dispatch final
    while (flushing) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (buffers.length > 0) {
      await dispatchBuffer(false);
    }
    try {
      onComplete?.();
    } catch {}
  });

  pcmStream.on("error", (e: Error) => {
    ended = true;
    clearInterval(flushTimer);
    console.warn(`[audio] decoder error user=${userId}:`, e.message);
    try {
      onComplete?.();
    } catch {}
  });
}

function encodeWav(pcm48kStereo: Buffer, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "s16le",
      "-ar", String(PCM_RATE),
      "-ac", String(PCM_CHANNELS),
      "-i", "-",
      "-ar", "16000", // Whisper friendly input rate
      "-ac", "1",     // mono
      "-f", "wav",
      "-y",
      outputPath,
    ]);

    let stderr = "";
    ff.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`));
    });

    ff.stdin?.write(pcm48kStereo);
    ff.stdin?.end();
  });
}
