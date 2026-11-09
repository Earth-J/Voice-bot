/**
 * Audio pipeline: per-speaker opus stream → PCM → periodic-flush sub-chunks → WAV.
 *
 * Each time Discord's voice receiver reports "speaking start" for a user, we
 * open an opus subscription that auto-ends after configured silence. Each opus
 * packet is decoded to PCM (48kHz stereo s16le) by the user's long-lived
 * OpusDecoder (opus-decoder.ts — NOT one decoder per utterance, that exhausted
 * the opusscript WASM heap) and appended to an in-memory buffer.
 *
 * Strategy (long-talk safe):
 *   - Keep the opus stream OPEN until actual silence (no force-destroy at maxMs)
 *   - Every `chunkFlushMs` ms, snapshot current buffer → encode WAV → dispatch
 *     to onChunk, then reset buffer and continue capturing
 *   - On stream 'end' (silence reached): onComplete fires FIRST (frees the speaker
 *     slot so the next utterance isn't missed), then the final flush runs
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
import { analyzePcm, padLeadingSilence } from "./pcm.ts";
import { isWasmTrap, type OpusDecoder } from "./opus-decoder.ts";

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
  /**
   * Silence prepended to every chunk before it is sent to Whisper (default 400ms).
   * Whisper often drops the first word when a clip starts abruptly; a short
   * lead-in fixes that. Set 0 to disable.
   */
  leadingSilenceMs?: number;
  /**
   * Chunks with less than this much speech-like audio (see analyzePcm — high-passed,
   * so wind rumble doesn't count) are dropped without calling STT (default 200ms).
   * Unlike minFinalChunkMs this measures real audio, not wall-clock time, so short
   * commands ("ข้าม", "หยุด") survive while wind gusts / mic bumps are dropped.
   */
  minVoicedMs?: number;
  /** Frame RMS (16-bit scale) at which a 20ms frame counts as voiced (default 300). */
  voicedFrameRms?: number;
}

const PCM_RATE = 48_000;
const PCM_CHANNELS = 2;

export function startSpeakerCapture(
  connection: VoiceConnection,
  userId: string,
  config: PipelineConfig,
  onChunk: ChunkHandler,
  onComplete: (() => void) | undefined,
  decoder: OpusDecoder,
): void {
  mkdirSync(TMP_DIR, { recursive: true });

  const receiver = connection.receiver;
  const opusStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: config.silenceThresholdMs,
    },
  });

  let buffers: Buffer[] = [];
  let subChunkStartedAt = Date.now();
  let flushSeq = 0;
  let flushing = false;
  let ended = false;

  const flushIntervalMs = config.chunkFlushMs ?? 8_000;
  const minFinalChunkMs = config.minFinalChunkMs ?? 1_500;
  const leadingSilenceMs = config.leadingSilenceMs ?? 400;
  const minVoicedMs = config.minVoicedMs ?? 200;
  const voicedFrameRms = config.voicedFrameRms ?? 300;

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
    // Noise gate: don't spend an STT call (and risk a hallucinated "command") on
    // wind / mic bumps / room noise. Measured on the audio itself, high-passed.
    const stats = analyzePcm(pcm, PCM_RATE, PCM_CHANNELS, { minFrameRms: voicedFrameRms });
    const verdict = stats.voicedMs < minVoicedMs ? "drop" : "keep";
    console.log(
      `[audio] ${verdict} user=${userId} audio=${Math.round(stats.audioMs)}ms ` +
        `voiced=${stats.voicedMs}ms (min ${minVoicedMs}) maxRms=${stats.maxFrameRms} (frame>=${voicedFrameRms})`,
    );
    if (verdict === "drop") {
      flushing = false;
      return;
    }
    const wavPath = join(
      TMP_DIR,
      `${startedAt}_${userId}_p${flushSeq}.wav`,
    );
    try {
      await encodeWav(
        padLeadingSilence(pcm, leadingSilenceMs, PCM_RATE, PCM_CHANNELS),
        wavPath,
      );
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

  let decodeErrors = 0;
  opusStream.on("data", (packet: Buffer) => {
    try {
      buffers.push(decoder.decode(packet));
    } catch (e: any) {
      // One bad packet must not kill the utterance — skip it. Log only the first few.
      if (++decodeErrors <= 3) {
        console.warn(`[audio] opus decode failed user=${userId}:`, e?.message ?? e);
      }
      if (isWasmTrap(e)) opusFatal(e);
    }
  });

  // Runs exactly once, whichever of end / error / close happens first.
  // ('close' also covers streams destroyed without 'end' — e.g. the voice
  // connection being torn down — which used to leak this interval forever.)
  let finished = false;
  const finalize = async (dispatchFinal: boolean): Promise<void> => {
    if (finished) return;
    finished = true;
    ended = true;
    clearInterval(flushTimer);
    // Release the speaker slot IMMEDIATELY — before the (slow) encode + STT of
    // the final chunk, otherwise a new "speaking start" from the same user is
    // ignored while the old stream is already closed and the first words of the
    // next utterance are lost.
    try {
      onComplete?.();
    } catch {}
    if (!dispatchFinal) return;
    // Wait for any in-flight flush, then dispatch final
    while (flushing) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (buffers.length > 0) {
      await dispatchBuffer(false);
    }
  };

  opusStream.on("end", () => void finalize(true));
  opusStream.on("error", (e: Error) => {
    console.warn(`[audio] opus stream error user=${userId}:`, e.message);
    void finalize(false);
  });
  opusStream.on("close", () => void finalize(false));
}

/**
 * The WASM heap is corrupted: no decoder can be created in this process any
 * more, so staying up just means a bot that silently stops hearing anyone.
 * Opt-in (OPUS_EXIT_ON_WASM_TRAP=true): exit and let Railway restart the container.
 */
let fatalScheduled = false;
function opusFatal(e: unknown): void {
  if (fatalScheduled) return;
  if (process.env.OPUS_EXIT_ON_WASM_TRAP !== "true") return;
  fatalScheduled = true;
  console.error("[audio] opus WASM heap is corrupted — exiting so the platform restarts us:", e);
  setTimeout(() => process.exit(1), 500);
}

export { opusFatal };

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
