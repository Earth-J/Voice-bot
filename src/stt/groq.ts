/**
 * Groq Whisper backend — fast cloud STT via the Groq LPU.
 * Auth via GROQ_API_KEY. Free tier is rate limited (HTTP 429), so transient
 * failures (429 / 5xx / network) are retried a few times before giving up.
 *
 * Env:
 *   GROQ_API_KEY            required
 *   GROQ_STT_MODEL          default "whisper-large-v3"
 *   GROQ_STT_LANGUAGE       default "th"; set "auto" to let Whisper detect
 *   GROQ_STT_PROMPT         hint to help Whisper spell the wake word; default
 *                           "Earth เอิร์ธ เปิดเพลง". Set empty to disable.
 *   GROQ_STT_TIMEOUT_MS     per-request timeout, default 30000
 *   GROQ_STT_RETRY_BASE_MS  base backoff when no Retry-After header, default 1000
 *   GROQ_NO_SPEECH_MAX      drop a segment if Whisper's no_speech_prob is above this
 *                           AND avg_logprob is below GROQ_AVG_LOGPROB_MIN. default 0.6
 *   GROQ_AVG_LOGPROB_MIN    default -1.0   (0.6 / -1.0 = Whisper's own "no speech" rule)
 *   GROQ_COMPRESSION_MAX    drop a segment above this gzip compression ratio
 *                           (runaway repetition). default 2.4
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { TranscribeResult } from "./types.ts";

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
  form.append("model", MODEL);
  if (LANGUAGE !== "auto") form.append("language", LANGUAGE);
  // opts.prompt "" = send no prompt at all (used to double-check suspected prompt echoes)
  const prompt = opts.prompt ?? activePrompt();
  if (prompt) form.append("prompt", prompt);
  form.append("response_format", "verbose_json");

  for (let attempt = 1; ; attempt++) {
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

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) {
      const wait = Math.min(
        retryAfterMs(res) ?? RETRY_BASE_MS * attempt,
        MAX_WAIT_MS,
      );
      console.warn(
        `[stt-groq] HTTP ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${wait}ms`,
      );
      await res.text().catch(() => "");
      await sleep(wait);
      continue;
    }

    const err = await res.text().catch(() => "");
    throw new Error(`[stt-groq] HTTP ${res.status}: ${err.slice(0, 300)}`);
  }
}
