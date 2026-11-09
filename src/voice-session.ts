/**
 * VoiceSession — per-guild listening connection (STT only; music runs on Lavalink).
 *
 * Lifecycle:  idle → connecting → listening → leaving → idle
 *
 * Earth listens to everyone in the channel (audio-pipeline.ts → Whisper STT).
 * Transcribed text is NOT stored anywhere — it is handed to `onSpeech`, which
 * decides whether it was a command ("earth เปิดเพลง ..."). Otherwise it is dropped.
 */
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  entersState,
  type AudioPlayer,
  type PlayerSubscription,
  type VoiceConnection,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import { unlink } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { getSfx, type SfxName } from "./sfx.ts";
import { startSpeakerCapture, opusFatal, type AudioChunk } from "./audio-pipeline.ts";
import { createOpusDecoder, isWasmTrap, opusBackendName, type OpusDecoder } from "./opus-decoder.ts";
import { transcribeAndCleanup } from "./stt/index.ts";
import { emptyUsage, formatUsage, type UsageMetrics } from "./cost.ts";

/** Numeric env var with a fallback; unlike `Number(x) || d` this lets 0 through. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

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
  /**
   * One long-lived opus decoder per listened user (NOT per utterance — churning
   * through WASM decoders is what corrupted the opusscript heap). Freed on disconnect.
   */
  private _decoders = new Map<string, OpusDecoder>();
  /** Bumped on connect + disconnect so late STT results from an old session are ignored. */
  private _epoch = 0;
  private _lastHumanSpeechAt = 0;
  /** While in the future, the auto-leave watchers skip this session. 0 = off. */
  private _persistentUntil = 0;
  private _usage: UsageMetrics = emptyUsage();
  /** Plays the short status sounds (sfx.ts) through this bot's own voice connection. */
  private _sfxPlayer: AudioPlayer | null = null;
  private _sfxSub: PlayerSubscription | null = null;

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
    this._freeDecoders();
    this._usage = emptyUsage();

    // This bot listens and plays short status sounds (music itself is played by the
    // separate Lavalink bot). NOT deafened (a deafened bot receives no audio) and NOT
    // muted (a self-muted bot's sounds may not be heard).
    const conn = joinVoiceChannel({
      channelId: args.channelId,
      guildId: args.guildId,
      adapterCreator: args.adapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    this._connection = conn;
    this._dropSfxPlayer();

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
      // Lead-in silence so Whisper doesn't clip an abrupt first word. 0 disables.
      leadingSilenceMs: envNumber("LEADING_SILENCE_MS", 400),
      // Noise gate (wind / mic bumps): chunks with < minVoicedMs of speech-like audio are skipped. 0 disables.
      minVoicedMs: envNumber("MIN_VOICED_MS", 200),
      voicedFrameRms: envNumber("VOICED_FRAME_RMS", 300),
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
        startSpeakerCapture(
          conn,
          userId,
          cfg,
          handleChunk,
          () => {
            // Only forget the speaker once the underlying opus stream truly
            // ends, so periodic flushes during one utterance don't drop it.
            this._activeSpeakers.delete(userId);
          },
          this._getDecoder(userId),
        );
      } catch (e) {
        this._activeSpeakers.delete(userId);
        console.warn(`[voice-session] startSpeakerCapture failed user=${userId}:`, e);
        if (isWasmTrap(e)) opusFatal(e);
      }
    });
  }

  /** The user's decoder, created on first use and reused for every later utterance. */
  private _getDecoder(userId: string): OpusDecoder {
    const existing = this._decoders.get(userId);
    if (existing) return existing;
    // Only matters when listening to everyone: keep the map bounded by evicting an idle user.
    const max = envNumber("OPUS_MAX_DECODERS", 8);
    if (this._decoders.size >= max) {
      for (const [id, d] of this._decoders) {
        if (this._activeSpeakers.has(id)) continue;
        d.destroy();
        this._decoders.delete(id);
        break;
      }
    }
    const d = createOpusDecoder();
    this._decoders.set(userId, d);
    console.log(
      `[voice-session] opus decoder created user=${userId} backend=${opusBackendName()} total=${this._decoders.size}`,
    );
    return d;
  }

  private _freeDecoders(): void {
    for (const d of this._decoders.values()) d.destroy();
    this._decoders.clear();
  }

  /** Play a short status sound in the voice channel. No-op if not connected or the file is missing. */
  playSfx(name: SfxName): void {
    if (this._state !== "listening" || !this._connection) return;
    const pcm = getSfx(name);
    if (!pcm) return;
    try {
      if (!this._sfxPlayer) {
        const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        player.on("error", (e: Error) => console.warn(`[sfx] player error:`, e.message));
        this._sfxPlayer = player;
        this._sfxSub = this._connection.subscribe(player) ?? null;
      }
      const stream = new PassThrough();
      stream.end(pcm);
      // A new sound cuts off the previous one (they are all very short).
      this._sfxPlayer.play(createAudioResource(stream, { inputType: StreamType.Raw }));
    } catch (e: any) {
      console.warn(`[sfx] could not play "${name}":`, e?.message ?? e);
    }
  }

  private _dropSfxPlayer(): void {
    try {
      this._sfxPlayer?.stop(true);
      this._sfxSub?.unsubscribe();
    } catch {}
    this._sfxPlayer = null;
    this._sfxSub = null;
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

    this._dropSfxPlayer();
    try {
      this._connection?.destroy();
    } catch (e) {
      console.warn("[voice-session] destroy error (ignored):", e);
    }
    this._connection = null;
    this._activeSpeakers.clear();
    this._freeDecoders(); // after destroy(): no more packets can arrive
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
