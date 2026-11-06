/**
 * VoiceSession — per-guild listening connection (STT only; music runs on Lavalink).
 *
 * Lifecycle:  idle → connecting → listening → leaving → idle
 *
 * Earth listens to everyone in the channel (audio-pipeline.ts → Groq Whisper).
 * Transcribed text is NOT stored anywhere — it is handed to `onSpeech`, which
 * decides whether it was a command ("earth/jarvis เปิดเพลง ..."). Otherwise it is dropped.
 */
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import { unlink } from "node:fs/promises";
import { startSpeakerCapture, type AudioChunk } from "./audio-pipeline.ts";
import { transcribeAndCleanup } from "./stt/index.ts";
import { emptyUsage, formatUsage, type UsageMetrics } from "./cost.ts";

export type SessionState = "idle" | "connecting" | "listening" | "leaving";

export interface SessionStatus {
  state: SessionState;
  channelId?: string;
  guildId?: string;
  channelName?: string;
  startedAt?: number;
  chunkCount: number;
}

export interface SpeechEvent {
  userId: string;
  text: string;
}

export interface ConnectArgs {
  channelId: string;
  guildId: string;
  channelName: string;
  adapterCreator: DiscordGatewayAdapterCreator;
  /** Silence ms before an utterance auto-ends (default 1500). */
  silenceThresholdMs?: number;
  /** Final chunks shorter than this are dropped (default 1500). */
  minFinalChunkMs?: number;
  /**
   * Only these users are listened to — everyone else's audio is never captured
   * or sent to STT. Empty/undefined = listen to everyone.
   */
  listenUserIds?: Set<string>;
  /** Called with every non-empty transcription. */
  onSpeech?: (ev: SpeechEvent) => void;
  /** Called when the voice connection is lost for good (kicked, channel deleted, ...). */
  onConnectionLost?: () => void;
}

export class VoiceSession {
  private _state: SessionState = "idle";
  private _connection: VoiceConnection | null = null;
  private _activeSpeakers = new Set<string>();
  /** Bumped on connect + disconnect so late STT results from an old session are ignored. */
  private _epoch = 0;
  private _lastHumanSpeechAt = 0;
  /** While in the future, the auto-leave watchers skip this session. 0 = off. */
  private _persistentUntil = 0;
  private _usage: UsageMetrics = emptyUsage();

  channelId?: string;
  guildId?: string;
  channelName?: string;
  startedAt?: number;
  chunkCount = 0;

  get state(): SessionState {
    return this._state;
  }

  async connect(args: ConnectArgs): Promise<void> {
    if (this._state !== "idle") {
      throw new Error(`cannot connect: session is ${this._state}`);
    }
    this._state = "connecting";
    const epoch = ++this._epoch;
    this.channelId = args.channelId;
    this.guildId = args.guildId;
    this.channelName = args.channelName;
    this.startedAt = Date.now();
    this._lastHumanSpeechAt = this.startedAt;
    this.chunkCount = 0;
    this._activeSpeakers.clear();
    this._usage = emptyUsage();

    // This bot only listens (music is played by the separate Lavalink bot), so it
    // joins self-muted. NOT deafened — a deafened bot receives no audio.
    const conn = joinVoiceChannel({
      channelId: args.channelId,
      guildId: args.guildId,
      adapterCreator: args.adapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    this._connection = conn;

    conn.on("stateChange", (oldS: any, newS: any) => {
      console.log(
        `[voice-debug] state ${oldS.status} → ${newS.status}` +
          (newS.reason ? ` (reason=${newS.reason})` : "") +
          (newS.closeCode ? ` (closeCode=${newS.closeCode})` : ""),
      );
    });
    conn.on("error" as any, (err: Error) => {
      console.warn("[voice-debug] connection error:", err.message);
    });

    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
      this._state = "listening";
    } catch (e) {
      try {
        conn.destroy();
      } catch {}
      this._connection = null;
      this._resetMeta();
      this._state = "idle";
      throw new Error(
        `failed to enter voice channel within 15s: ${(e as Error).message}`,
      );
    }

    // Disconnected → either Discord is moving us (it reconnects on its own
    // within a few seconds) or we were kicked / the channel was deleted.
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (
          this._epoch === epoch &&
          this._connection === conn &&
          this._state === "listening"
        ) {
          console.warn("[voice-session] connection lost for good — notifying");
          args.onConnectionLost?.();
        }
      }
    });

    // ── Per-speaker capture ────────────────────────────────────────────────
    const cfg = {
      silenceThresholdMs: args.silenceThresholdMs ?? 1500,
      chunkFlushMs: Number(process.env.CHUNK_FLUSH_MS) || 8_000,
      minFinalChunkMs:
        args.minFinalChunkMs ?? (Number(process.env.MIN_FINAL_CHUNK_MS) || 1_500),
    };

    const handleChunk = async (chunk: AudioChunk): Promise<void> => {
      // Chunk from a session that already ended — discard (and delete the WAV).
      if (this._epoch !== epoch) {
        await unlink(chunk.wavPath).catch(() => {});
        return;
      }
      this.chunkCount++;
      await this._transcribeChunk(chunk, epoch, args.onSpeech);
    };

    conn.receiver.speaking.on("start", (userId: string) => {
      if (this._epoch !== epoch) return;
      if (args.listenUserIds?.size && !args.listenUserIds.has(userId)) return;
      if (this._activeSpeakers.has(userId)) return;
      this._activeSpeakers.add(userId);
      try {
        startSpeakerCapture(conn, userId, cfg, handleChunk, () => {
          // Only forget the speaker once the underlying opus stream truly
          // ends, so periodic flushes during one utterance don't drop it.
          this._activeSpeakers.delete(userId);
        });
      } catch (e) {
        this._activeSpeakers.delete(userId);
        console.warn(`[voice-session] startSpeakerCapture failed user=${userId}:`, e);
      }
    });
  }

  /** STT one audio chunk and pass the text on. Nothing is saved. */
  private async _transcribeChunk(
    chunk: AudioChunk,
    epoch: number,
    onSpeech?: (ev: SpeechEvent) => void,
  ): Promise<void> {
    try {
      this._usage.sttCallCount++;
      this._usage.sttAudioSec += chunk.durationMs / 1000;
      const { text } = await transcribeAndCleanup(chunk.wavPath);
      // Session ended (or a new one started) while STT was running.
      if (this._epoch !== epoch) return;
      if (!text) return; // silence / noise / hallucination

      this._lastHumanSpeechAt = chunk.endedAt;
      console.log(`[voice-session] heard user=${chunk.userId}: "${text}"`);
      onSpeech?.({ userId: chunk.userId, text });
    } catch (e: any) {
      this._usage.sttFailedCount++;
      console.warn(
        `[voice-session] transcribe failed user=${chunk.userId}:`,
        e?.message ?? e,
      );
    }
  }

  async disconnect(): Promise<{ chunks: number; durationMs: number; channelName?: string }> {
    if (this._state === "idle") {
      return { chunks: 0, durationMs: 0 };
    }
    this._state = "leaving";
    const chunks = this.chunkCount;
    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const channelName = this.channelName;

    try {
      this._connection?.destroy();
    } catch (e) {
      console.warn("[voice-session] destroy error (ignored):", e);
    }
    this._connection = null;
    this._activeSpeakers.clear();
    this._epoch++; // invalidate any STT still in flight
    this._resetMeta();
    this._state = "idle";

    return { chunks, durationMs, channelName };
  }

  getStatus(): SessionStatus {
    return {
      state: this._state,
      channelId: this.channelId,
      guildId: this.guildId,
      channelName: this.channelName,
      startedAt: this.startedAt,
      chunkCount: this.chunkCount,
    };
  }

  /** Wall-clock ms of the last successful transcription (falls back to startedAt). */
  getLastHumanSpeechAt(): number {
    return this._lastHumanSpeechAt || this.startedAt || Date.now();
  }

  // ─── Persistent mode (skip auto-leave watchers) ────────────────────────────
  isPersistent(): boolean {
    return this._persistentUntil > 0 && Date.now() < this._persistentUntil;
  }
  getPersistentUntil(): number {
    return this._persistentUntil;
  }
  setPersistent(ms: number): void {
    this._persistentUntil = Date.now() + Math.max(0, ms);
  }
  clearPersistent(): void {
    this._persistentUntil = 0;
  }

  getUsage(): UsageMetrics {
    return { ...this._usage };
  }

  getUsageReport(): string {
    return formatUsage(this._usage);
  }

  private _resetMeta() {
    this.channelId = undefined;
    this.guildId = undefined;
    this.channelName = undefined;
    this.startedAt = undefined;
    this.chunkCount = 0;
    this._persistentUntil = 0;
  }
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
