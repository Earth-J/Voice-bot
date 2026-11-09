/**
 * Whisper "prompt echo" detection.
 *
 * The STT prompt (GROQ_STT_PROMPT) is there to help Whisper spell the wake word,
 * but on noise / wind / breathing Whisper often just repeats the prompt back.
 * That is dangerous here: the echo reads like a real command
 * ("เอิร์ธ เปิดเพลง หยุดเพลง" → play a song called "หยุดเพลง"), so it would
 * trigger music, skips and queue removals out of thin air.
 *
 * Text alone cannot always tell an echo from a real command that happens to use
 * the same words, so there are three verdicts:
 *   "certain" — the whole prompt came back (nobody says that on purpose) → drop
 *   "suspect" — mostly prompt text, long enough to matter → re-check the audio
 *               WITHOUT the prompt; real speech survives that, noise doesn't
 *   "none"    — normal transcript (short commands like "เอิร์ธ ข้าม" land here)
 */

/** Letters, digits and combining marks only — Thai tone/vowel marks are \p{M}. */
export function normalizeForEcho(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "");
}

/**
 * Share (0-1) of `text` that is made of runs (≥ minRun chars) copied verbatim
 * from `prompt`. Short coincidental overlaps ("เพลง") don't count.
 */
export function promptCoverage(text: string, prompt: string, minRun = 8): number {
  const t = normalizeForEcho(text);
  const p = normalizeForEcho(prompt);
  if (!t || !p) return 0;
  let covered = 0;
  let i = 0;
  while (i < t.length) {
    let len = 0;
    while (i + len < t.length && p.includes(t.slice(i, i + len + 1))) len++;
    if (len >= minRun) {
      covered += len;
      i += len;
    } else {
      i++;
    }
  }
  return covered / t.length;
}

export type EchoVerdict = "none" | "suspect" | "certain";

/**
 * A prompt shorter than this (normalized chars) is too easy to say by accident
 * ("เอิร์ธ เปิดเพลง" is a real command AND a plausible prompt), so no echo logic runs.
 */
const MIN_PROMPT_CHARS = 20;
/**
 * Transcripts shorter than this are never second-guessed. Real commands are short
 * and often appear verbatim in the prompt ("เอิร์ธ ข้าม" = 10, "เอิร์ธ ลบคิว 2" = 12,
 * "เอิร์ธ เงียบหน่อย" ≈ 14); echoed song requests / command chains are 25+.
 */
const MIN_SUSPECT_CHARS = 20;

export function classifyPromptEcho(text: string, prompt: string): EchoVerdict {
  const t = normalizeForEcho(text);
  const p = normalizeForEcho(prompt);
  if (!t || p.length < MIN_PROMPT_CHARS) return "none";
  // The whole prompt repeated, with little else added.
  if (t.includes(p) && t.length <= p.length * 1.5) return "certain";
  if (t.length < MIN_SUSPECT_CHARS) return "none";
  const cov = promptCoverage(text, prompt);
  if (cov >= 0.95 && t.length >= p.length * 0.7) return "certain";
  if (cov >= 0.8) return "suspect";
  return "none";
}

/** Dice coefficient on character bigrams (0-1) — tolerant of spelling differences. */
export function similarity(a: string, b: string): number {
  const x = normalizeForEcho(a);
  const y = normalizeForEcho(b);
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      overlap++;
      grams.set(g, n - 1);
    }
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

/** Did the prompt-free transcription say (roughly) the same thing? */
export function agreesWithoutPrompt(prompted: string, unprompted: string): boolean {
  return similarity(prompted, unprompted) >= 0.5;
}
