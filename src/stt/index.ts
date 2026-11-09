/**
 * STT entry point — Groq Whisper cloud (./groq.ts, GROQ_API_KEY).
 *
 * Post-process: every transcript is run through ./hallucinations.ts.
 * Hallucinated text → empty string (caller treats it as silence, nothing is stored).
 */
import { unlink } from "node:fs/promises";
import { isHallucination } from "./hallucinations.ts";
import { transcribeGroq } from "./groq.ts";
import type { TranscribeResult } from "./types.ts";

/** Startup check: error message if Groq isn't configured, else null. */
export function sttConfigError(): string | null {
  return process.env.GROQ_API_KEY
    ? null
    : "GROQ_API_KEY missing in .env — get one at https://console.groq.com";
}

/** One-line description for the startup log. */
export function sttSummary(): string {
  return `groq (${process.env.GROQ_STT_MODEL || "whisper-large-v3"}, lang=${process.env.GROQ_STT_LANGUAGE || "th"})`;
}

export async function transcribe(wavPath: string): Promise<TranscribeResult> {
  const raw = await transcribeGroq(wavPath);
  if (raw.text && isHallucination(raw.text)) {
    console.log(`[stt] hallucination dropped: "${raw.text.slice(0, 80)}"`);
    return { ...raw, text: "" };
  }
  return raw;
}

/** Transcribe, then always delete the WAV (privacy: audio discarded post-STT). */
export async function transcribeAndCleanup(
  wavPath: string,
): Promise<TranscribeResult> {
  try {
    return await transcribe(wavPath);
  } finally {
    try {
      await unlink(wavPath);
    } catch {
      // already gone
    }
  }
}

export type { TranscribeResult };
