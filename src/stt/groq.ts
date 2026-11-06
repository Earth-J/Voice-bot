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
 *                           "Earth Jarvis เอิร์ธ จาร์วิส เปิดเพลง". Set empty to disable.
 *   GROQ_STT_TIMEOUT_MS     per-request timeout, default 30000
 *   GROQ_STT_RETRY_BASE_MS  base backoff when no Retry-After header, default 1000
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { TranscribeResult } from "./types.ts";

const MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3";
const LANGUAGE = process.env.GROQ_STT_LANGUAGE || "th";
const PROMPT = process.env.GROQ_STT_PROMPT ?? "Earth Jarvis เอิร์ธ จาร์วิส เปิดเพลง";
const API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const REQUEST_TIMEOUT_MS = Number(process.env.GROQ_STT_TIMEOUT_MS) || 30_000;
const RETRY_BASE_MS = Number(process.env.GROQ_STT_RETRY_BASE_MS) || 1_000;
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : null;
}

export async function transcribeGroq(wavPath: string): Promise<TranscribeResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("[stt-groq] GROQ_API_KEY missing in .env");
  }

  const buf = await readFile(wavPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), basename(wavPath));
  form.append("model", MODEL);
  if (LANGUAGE !== "auto") form.append("language", LANGUAGE);
  if (PROMPT) form.append("prompt", PROMPT);
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
      };
      return {
        text: (json.text ?? "").trim(),
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
