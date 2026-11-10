/**
 * Groq Whisper backend — fast cloud STT via the Groq LPU.
 * Auth via GROQ_API_KEY. Free tier is rate limited (HTTP 429: 20 requests/min per
 * model, counted for the whole Groq organization), so every request goes through a
 * client-side limiter (./rate-limit.ts) and transient failures (429 / 5xx / network)
 * are retried a few times before giving up.
 *
 * Env:
 *   GROQ_API_KEY            required
 *   GROQ_STT_MODEL          default "whisper-large-v3"
 *   GROQ_STT_LANGUAGE       default "th"; set "auto" to let Whisper detect
 *   GROQ_STT_PROMPT         hint to help Whisper spell the wake word; default
 *                           "Earth เอิร์ธ เปิดเพลง". Set empty to disable.
 *   GROQ_STT_TIMEOUT_MS     per-request timeout, default 30000
 *   GROQ_STT_RETRY_BASE_MS  base backoff when no Retry-After header, default 1000
 *   GROQ_STT_MAX_RPM        our own cap: requests per minute per model, default 18
 *                           (Groq free = 20; the margin covers anything else using the
 *                           same key). Raise it after upgrading your Groq plan. 0 = no cap.
 *   GROQ_STT_MAX_QUEUE_WAIT_MS
 *                           a chunk that would wait longer than this for a free slot is
 *                           dropped instead — a stale voice command is worse than a lost
 *                           one. default 8000
 *   GROQ_STT_FALLBACK_MODEL optional spill-over model, e.g. "whisper-large-v3-turbo".
 *                           Groq counts quota per model, so when the main model is full
 *                           (or answers 429) chunks go to this one. It is faster but less
 *                           accurate for Thai. default: off
 *   GROQ_STT_FALLBACK_MAX_RPM  cap for the fallback model, default = GROQ_STT_MAX_RPM
 *   GROQ_NO_SPEECH_MAX      drop a segment if Whisper's no_speech_prob is above this
 *                           AND avg_logprob is below GROQ_AVG_LOGPROB_MIN. default 0.6
 *   GROQ_AVG_LOGPROB_MIN    default -1.0   (0.6 / -1.0 = Whisper's own "no speech" rule)
 *   GROQ_COMPRESSION_MAX    drop a segment above this gzip compression ratio
 *                           (runaway repetition). default 2.4
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { SlidingWindowLimiter, SttQueueTimeoutError } from "./rate-limit.ts";
import type { TranscribeResult } from "./types.ts";

export { SttQueueTimeoutError };

const MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3";
const LANGUAGE = process.env.GROQ_STT_LANGUAGE || "th";
const DEFAULT_PROMPT = "Earth เอิร์ธ เปิดเพลง";
/** The prompt in effect now (read per call, so env changes and tests take effect). */
export function activePrompt(): string {
  return process.env.GROQ_STT_PROMPT ?? DEFAULT_PROMPT;
}
const API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const REQUEST_TIMEOUT_MS = Number(process.env.GROQ_STT_TIMEOUT_MS) || 30_000;
const RETRY_BASE_MS = Number(process.env.GROQ_STT_RETRY_BASE_MS) || 1_000;
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 10_000;

const envNum = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const NO_SPEECH_MAX = envNum("GROQ_NO_SPEECH_MAX", 0.6);
const AVG_LOGPROB_MIN = envNum("GROQ_AVG_LOGPROB_MIN", -1.0);
const COMPRESSION_MAX = envNum("GROQ_COMPRESSION_MAX", 2.4);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Client-side rate limiting ───────────────────────────────────────────────

/** Read per call (like activePrompt) so env changes and tests take effect. */
function limitConfig() {
  const fb = (process.env.GROQ_STT_FALLBACK_MODEL ?? "").trim();
  const maxRpm = envNum("GROQ_STT_MAX_RPM", 18);
  return {
    /** Main model first, then the optional spill-over model. */
    models: fb && fb !== MODEL ? [MODEL, fb] : [MODEL],
    maxRpm,
    fallbackRpm: envNum("GROQ_STT_FALLBACK_MAX_RPM", maxRpm),
    maxQueueWaitMs: envNum("GROQ_STT_MAX_QUEUE_WAIT_MS", 8_000),
  };
}
type LimitConfig = ReturnType<typeof limitConfig>;

// One limiter per model, shared by every voice session in the process
// (Groq's quota is per organization, not per Discord server).
const limiters = new Map<string, SlidingWindowLimiter>();
function limiterFor(model: string, rpm: number): SlidingWindowLimiter {
  let l = limiters.get(model);
  if (!l) {
    l = new SlidingWindowLimiter({ maxPerWindow: rpm > 0 ? rpm : Infinity });
    limiters.set(model, l);
  }
  return l;
}

let announced = false;
/** Forget all limiter state (tests). */
export function resetRateLimiters(): void {
  limiters.clear();
  announced = false;
}

function announceLimits(cfg: LimitConfig): void {
  if (announced) return;
  announced = true;
  const cap = (rpm: number) => (rpm > 0 ? `<=${rpm}/min` : "no cap");
  const parts = cfg.models.map((m, i) => `${m} ${cap(i === 0 ? cfg.maxRpm : cfg.fallbackRpm)}`);
  console.log(
    `[stt-groq] rate limiter on: ${parts.join(" -> spill-over ")}, max queue wait ${cfg.maxQueueWaitMs}ms`,
  );
}

/** The model that can take a request soonest — the main model whenever it has a free slot. */
function pickSlot(cfg: LimitConfig): { model: string; limiter: SlidingWindowLimiter } {
  let pick = { model: cfg.models[0]!, limiter: limiterFor(cfg.models[0]!, cfg.maxRpm) };
  let pickWait = pick.limiter.estimateWaitMs();
  for (let i = 1; i < cfg.models.length && pickWait > 0; i++) {
    const model = cfg.models[i]!;
    const limiter = limiterFor(model, cfg.fallbackRpm);
    const wait = limiter.estimateWaitMs();
    if (wait < pickWait) {
      pick = { model, limiter };
      pickWait = wait;
    }
  }
  return pick;
}

/** "try again in 3s" / "1m30.5s" / "250ms" inside Groq's 429 message → ms (null if absent). */
export function parseTryAgainMs(body: string): number | null {
  const m = /try again in\s+([0-9hms.]+)/i.exec(body);
  if (!m?.[1]) return null;
  let total = 0;
  let found = false;
  for (const part of m[1].matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    found = true;
    const n = Number(part[1]);
    total +=
      part[2] === "ms" ? n : part[2] === "s" ? n * 1000 : part[2] === "m" ? n * 60_000 : n * 3_600_000;
  }
  return found ? Math.ceil(total) : null;
}

/** Which quota was hit, from "... on requests per minute (RPM): Limit 20, Used 20 ...". */
function limitKind(body: string): string {
  return /\((RPM|RPD|TPM|TPD|ASH|ASD)\)/.exec(body)?.[1] ?? "rate limit";
}

// ─── Noise filter ────────────────────────────────────────────────────────────

export interface WhisperSegment {
  text?: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
}

/**
 * Whisper happily "transcribes" wind and room noise into fluent text. The
 * verbose_json response says how sure it is, per segment, so use that:
 * drop a segment when the model itself thinks it is probably not speech
 * (no_speech_prob high AND avg_logprob low — both must hold, as in the
 * reference Whisper implementation) or when it is a repetition loop.
 *
 * With no usable segment data the plain `fallbackText` is returned untouched.
 */
export function dropNoiseSegments(
  segments: WhisperSegment[] | undefined,
  fallbackText: string,
  limits = { noSpeechMax: NO_SPEECH_MAX, avgLogprobMin: AVG_LOGPROB_MIN, compressionMax: COMPRESSION_MAX },
): { text: string; dropped: WhisperSegment[] } {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { text: fallbackText.trim(), dropped: [] };
  }
  const kept: string[] = [];
  const dropped: WhisperSegment[] = [];
  for (const seg of segments) {
    const noSpeech = seg.no_speech_prob;
    const logprob = seg.avg_logprob;
    const ratio = seg.compression_ratio;
    const notSpeech =
      typeof noSpeech === "number" &&
      typeof logprob === "number" &&
      noSpeech > limits.noSpeechMax &&
      logprob < limits.avgLogprobMin;
    const loop = typeof ratio === "number" && ratio > limits.compressionMax;
    if (notSpeech || loop) dropped.push(seg);
    else kept.push(seg.text ?? "");
  }
  return { text: kept.join("").trim(), dropped };
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : null;
}

export async function transcribeGroq(
  wavPath: string,
  opts: { prompt?: string } = {},
): Promise<TranscribeResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("[stt-groq] GROQ_API_KEY missing in .env");
  }

  const buf = await readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), basename(wavPath));
  if (LANGUAGE !== "auto") form.append("language", LANGUAGE);
  // opts.prompt "" = send no prompt at all (used to double-check suspected prompt echoes)
  const prompt = opts.prompt ?? activePrompt();
  if (prompt) form.append("prompt", prompt);
  form.append("response_format", "verbose_json");

  const cfg = limitConfig();
  announceLimits(cfg);

  for (let attempt = 1; ; attempt++) {
    // Take the model that can serve us soonest, then wait for our turn on it.
    // Throws SttQueueTimeoutError when that would take longer than the queue budget.
    const slot = pickSlot(cfg);
    if (slot.model !== MODEL) {
      console.log(`[stt-groq] ${MODEL} is at its limit — sending this chunk to ${slot.model}`);
    }
    await slot.limiter.acquire(cfg.maxQueueWaitMs);
    form.set("model", slot.model);

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e: any) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`[stt-groq] network error: ${e?.message ?? e}`);
      }
      await sleep(Math.min(RETRY_BASE_MS * attempt, MAX_WAIT_MS));
      continue;
    }

    if (res.ok) {
      const json = (await res.json()) as {
        text?: string;
        language?: string;
        duration?: number;
        segments?: WhisperSegment[];
      };
      const { text, dropped } = dropNoiseSegments(json.segments, json.text ?? "");
      for (const seg of dropped) {
        console.log(
          `[stt-groq] drop noise segment no_speech=${seg.no_speech_prob?.toFixed(2)} ` +
            `logprob=${seg.avg_logprob?.toFixed(2)} cr=${seg.compression_ratio?.toFixed(2)}: ` +
            `"${(seg.text ?? "").trim().slice(0, 80)}"`,
        );
      }
      return {
        text,
        language: json.language ?? (LANGUAGE === "auto" ? undefined : LANGUAGE),
        durationSec: json.duration,
      };
    }

    const body = await res.text().catch(() => "");

    if (res.status === 429) {
      // Tell the limiter: nobody (queued or new) sends to this model until the server
      // is ready again. Because the pause is shared, the other chunks that are waiting
      // do not all retry at once and burn the quota again.
      const hint = retryAfterMs(res) ?? parseTryAgainMs(body) ?? RETRY_BASE_MS * attempt;
      slot.limiter.pause(
        hint > 0 ? hint + 200 : 0,
        `HTTP 429 on ${slot.model} (${limitKind(body)})`,
      );
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `[stt-groq] HTTP 429 (${limitKind(body)}) on ${slot.model} — retry ${attempt}/${MAX_ATTEMPTS - 1}, model paused ${hint}ms`,
        );
        // No sleep here: acquire() at the top waits out the pause, or the other model takes over.
        continue;
      }
    } else if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
      const wait = Math.min(retryAfterMs(res) ?? RETRY_BASE_MS * attempt, MAX_WAIT_MS);
      console.warn(
        `[stt-groq] HTTP ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${wait}ms`,
      );
      await sleep(wait);
      continue;
    }

    throw new Error(`[stt-groq] HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
}
