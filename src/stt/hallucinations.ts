/**
 * Whisper Thai hallucination filter — static regex patterns.
 *
 * On silence/noise input, Whisper (esp. large-v3) falls back to high-frequency
 * Thai outro/intro patterns it saw during training (YouTube/TV/podcast). These
 * never appear in real voice-chat conversation, so we suppress them.
 *
 * Two filter layers:
 *   1. BUILTIN_HALLUCINATIONS — static regex list of known artifacts
 *   2. Repetition detection   — catches runaway decode loops
 *      (whisper-server lacks the -cr flag whisper-cli has)
 *
 * Add BUILTIN patterns sparingly. Each entry must be:
 *   1. A complete utterance Whisper outputs on silence/noise
 *   2. Vanishingly unlikely as real voice-chat speech
 *   3. Documented (where it came from / why it's a hallucination)
 *
 * Runtime override: STT_EXTRA_HALLUCINATIONS env (comma-separated).
 */

/** Canonical hallucination phrases — full-string match after trim + collapse-whitespace. */
const BUILTIN_HALLUCINATIONS: RegExp[] = [
  // YouTube/podcast outro
  /^โปรด\s*ติดตาม\s*(ตอน\s*ต่อ\s*ไป|ใน\s*ตอน\s*ต่อ\s*ไป)$/,
  /^ขอบคุณ(ที่|มาก\s*ที่)?\s*(รับ\s*ชม|ติดตาม)$/,
  /^ขอบคุณ\s*ที่\s*รับ\s*ชม\s*(ครับ|ค่ะ|นะ\s*ครับ|นะ\s*คะ)?$/,

  // YouTube CTA / subscribe noise
  /^(กด\s*)?(ไลก์|ไลค์|like|subscribe)\s*(กด\s*)?(แชร์|share|subscribe|กด\s*ติดตาม)/i,
  /^อย่า\s*ลืม\s*กด\s*ไลก์(\s*และ\s*กด\s*ติดตาม)?$/,
  /กด\s*ติดตาม\s*ใน/, // "กดติดตามในคอร์โมท" (Wind mic 2026-05-17)

  // Generic outro
  /^สวัสดี\s*(ค่ะ|ครับ)\s*ยินดี\s*ต้อนรับ$/,
  /^แล้ว\s*เจอ\s*กัน\s*ใหม่\s*(ครับ|ค่ะ|นะ\s*ครับ|นะ\s*คะ)?$/,

  // Thai sports betting / news (Wind mic 2026-05-17)
  /(ทีเด็ด|วิเคราะห์)\s*(ฟุต)?บอล/,
  /บอล\s*(สเต็ป|เต็ง)/,
  /^FB\s*(ชัชชาติ|สิทธิพ)/,

  // Subtitle-source artifacts
  /^\(เพลง\)$/,
  /^\(เสียง\s*เพลง\)$/,
  /^\(ดนตรี\)$/,
  /^\[เพลง\]$/,
  /^\(.*\)$/, // standalone parenthetical (e.g. "(เสียงหัวเราะ)")
];

// ---------------------------------------------------------------------------
// Repetition detection — compression-ratio guard
// ---------------------------------------------------------------------------

/** Common Thai filler / stutter tokens. Legitimate speakers repeat these. */
const FILLERS = new Set([
  "อ่า", "อะ", "อา", "ก็", "เอ่อ", "อืม", "อูย", "ครับ", "ค่ะ", "นะ",
  "ใช่", "เออ", "ละ", "แล้ว", "ที่", "เนี่ย", "อ่ะ", "หนะ",
  "เอ๊ะ", "หา", "อ๋อ", "อ๊ะ", "อ้าว",
]);

function isFillerPhrase(phrase: string): boolean {
  return phrase.split(/\s+/).every((p) => FILLERS.has(p));
}

/**
 * Returns the dominant repeated phrase, or null. Conservative — designed to
 * miss some hallucinations rather than discard real stuttered speech.
 *
 * Triggers when a non-filler phrase (≥5 chars, 2-6 words) either:
 *   (a) repeats consecutively ≥3 times, OR
 *   (b) occupies >55% of total words across ≥3 non-consecutive occurrences
 */
export function detectRepetition(text: string): string | null {
  const words = text.trim().split(/\s+/);
  if (words.length < 8) return null;

  const limit = Math.min(6, Math.floor(words.length / 3));
  for (let len = 2; len <= limit; len++) {
    const phrase = words.slice(0, len).join(" ");
    if (phrase.length < 5 || isFillerPhrase(phrase)) continue;

    let count = 0;
    for (let i = 0; i + len <= words.length; i += len) {
      if (words.slice(i, i + len).join(" ") === phrase) count++;
      else break;
    }
    if (count >= 3) return phrase;
  }

  for (let len = 2; len <= Math.min(6, Math.floor(words.length / 3)); len++) {
    const freq = new Map<string, number>();
    for (let i = 0; i + len <= words.length; i++) {
      const p = words.slice(i, i + len).join(" ");
      if (p.length < 5 || isFillerPhrase(p)) continue;
      freq.set(p, (freq.get(p) ?? 0) + 1);
    }
    for (const [phrase, n] of freq) {
      if (n >= 3 && (n * len) / words.length > 0.55) return phrase;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pattern loading
// ---------------------------------------------------------------------------

function loadExtraPatterns(): RegExp[] {
  const raw = process.env.STT_EXTRA_HALLUCINATIONS;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m && m[1]) return new RegExp(m[1], m[2] ?? "");
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}$`);
  });
}

const PATTERNS: RegExp[] = [...BUILTIN_HALLUCINATIONS, ...loadExtraPatterns()];

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Returns true if `text` is judged a Whisper hallucination and should be
 * dropped (not appended to transcript, not used as trigger).
 */
export function isHallucination(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  for (const re of PATTERNS) if (re.test(t)) return true;
  if (detectRepetition(t)) return true;
  return false;
}

export function listHallucinationPatterns(): readonly RegExp[] {
  return PATTERNS;
}
