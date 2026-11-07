/**
 * Voice command parser.
 *
 * The ONLY things the bot reacts to are:
 *     "earth/jarvis เปิดเพลง <ชื่อเพลง>"   → play a song
 *     "earth/jarvis เงียบ" / "earth/jarvis เงียบหน่อย" / "earth/jarvis stop" → stop the song
 *     "earth/jarvis เพิ่มเสียง" / "earth/jarvis เบาเสียง" → volume +5 / -5
 *     "earth/jarvis ข้าม" / "earth/jarvis skip" → skip to the next song in the queue
 *     "earth/jarvis เตะผม"                → disconnect the speaker from voice
 *     "earth/jarvis เพิ่มเพลง <ชื่อเพลง>"  → add a song to the queue
 *     "earth/jarvis แสดงคิว"               → post the queue in the queue channel
 *     "earth/jarvis ลบคิว <เลขลำดับ>"       → remove queue item #N
 * Everything else that gets transcribed is ignored (the bot stays silent).
 *
 * Whisper writes the wake word in many ways (Earth / เอิร์ธ / Jarvis / จาร์วิส ...),
 * so the wake word is matched loosely. The verb must come right after it, which
 * keeps false triggers rare.
 */

// optional Thai tone mark (่ ้ ๊ ๋)
const T = "[\\u0E48-\\u0E4B]?";

/** Spellings of the wake word. Longest alternatives first. */
const WAKE = [
  // --- Earth ---
  "earth",
  "erth",
  "urth",
  `เอ[ิอ]?${T}ร?์?[ธทดต]`, // เอิร์ธ / เอิร์ท / เออร์ธ / เอิธ
  // --- Jarvis ---
  "jarvis",
  "jarvice",
  "jervis",
  "jarves",
  `จ${T}า${T}ร?์?\\s*วิ${T}[สดชศซ]`, // จาร์วิส / จาวิส / จาร์วิด / จาร์วิช
].join("|");

/** Words meaning "play a song". Add synonyms here if you want more. */
const VERB = ["เปิด\\s*เพลง"].join("|");
/**
 * Words meaning "stop the song" ("เงียบ" or "stop"). "เงียบหน่อย" / "เงียบๆ" are covered because
 * the regex is a prefix match (nothing is required after the verb).
 */
const STOP_VERB = [
  "เงียบ",
  "เนียบ",
  `หยุ[ดตท]`,
  `(?:จุด|ยุทธ|ยุด|ยุต|จิต|ยูด|หยูด)\\s*เพ็?[ลง]`, // เติมคำที่เจอจริงตรงนี้
  "stop",
  `สต${T}็?อ[ปบพ]`,
].join("|");

// <wake> [ช่วย|ขอ] เปิดเพลง <query>
const COMMAND_RE = new RegExp(
  `(?:${WAKE})[\\s,.:;!?'"“”-]*(?:ช่วย|ขอ)?\\s*(?:${VERB})(.*)$`,
  "is",
);

/** Volume step per command (percent). */
export const VOLUME_STEP = 5;

/**
 * Whisper often mishears short Thai words, so each volume verb accepts the
 * spellings it tends to produce. Safe because the wake word must come right
 * before and "เสียง" right after.
 */
const VOL_UP = ["เพิ่ม", "เพิม", "เพ่ม"].join("|");
// "เบา" is short and tonal, so Whisper often writes it as เปล่า / บ่า / เปา ...
// Add more spellings here as you see them in the console log. Safe because the
// wake word must come right before and "เสียง" right after.
const VOL_DOWN = [
  `เบ${T}า`, // เบา / เบ่า / เบ้า
  `เป${T}า`, // เปา / เป่า
  `เปล${T}า`, // เปลา / เปล่า / เปล้า
  `บ${T}า`, // บา / บ่า / บ้า
].join("|");

// <wake> [ช่วย|ขอ] เพิ่มเสียง | เบาเสียง
const VOLUME_RE = new RegExp(
  `(?:${WAKE})[\\s,.:;!?'"“”-]*(?:ช่วย|ขอ)?\\s*(?:(${VOL_UP})|(?:${VOL_DOWN}))${T}\\s*เสียง`,
  "i",
);

// <wake> [ช่วย|ขอ] เงียบ [หน่อย]
const STOP_RE = new RegExp(
  `(?:${WAKE})[\\s,.:;!?'"“”-]*(?:ช่วย|ขอ)?\\s*(?:${STOP_VERB})`,
  "i",
);

/**
 * "kick me" — disconnects whoever said it (never anyone else).
 * Tone mark can sit on ต (เต๊ะ / เต้ะ) when Whisper mishears. Pronoun after
 * the verb is required so a plain "เตะ" (kick, e.g. football) never triggers.
 */
const KICK_PRONOUN = ["ผม", "ฉัน", "ดิฉัน", "เรา", "หนู", "กู", "ข้า"].join("|");
const KICK_RE = new RegExp(
  `(?:${WAKE})[\\s,.:;!?'"“”-]*(?:ช่วย|ขอ)?\\s*เต${T}ะ\\s*(?:${KICK_PRONOUN})`,
  "i",
);

const LEADING_FILLER = /^[\s,.:;!?'"“”-]*(?:ว่า|ชื่อ|ที่ชื่อ|เรื่อง)?[\s,.:;!?'"“”-]*(?:ให้ฟัง|ให้หน่อย)?/;
const TRAILING_FILLER =
  /[\s,.:;!?'"“”-]*(?:หน่อย|ที)?(?:นะ)?(?:ครับ|ค่ะ|คะ|จ้า|จ้ะ)?[\s,.:;!?'"“”-]*$/;

const MAX_QUERY_LEN = 120;

// <wake> [ช่วย|ขอ] ข้าม | skip   (Whisper may write ข้าม as ข่าม, skip as สกิป / สกิบ)
const SKIP_RE = new RegExp(
  `(?:${WAKE})[\\s,.:;!?'"“”-]*(?:ช่วย|ขอ)?\\s*(?:ข${T}าม|skip|สกิ${T}[ปบพ])`,
  "i",
);

// ─── Queue commands ──────────────────────────────────────────────────────────
// "คิว" is a short tonal word, so accept a few Whisper spellings (คิ้ว / ควิ / queue).
const QUEUE_WORD = `(?:คิ${T}ว|ควิ|queue)`;
const PREFIX = `(?:${WAKE})[\\s,.:;!?'"“”-]*(?:ช่วย|ขอ)?\\s*`;

// <wake> เพิ่มเพลง [ในคิว] <query>  |  เพิ่มคิว / ต่อคิว / ใส่คิว [เพลง] <query>
const QUEUE_ADD_RE = new RegExp(
  `${PREFIX}(?:(?:${VOL_UP})\\s*เพลง(?:\\s*(?:ใน|เข้า)\\s*${QUEUE_WORD})?|(?:${VOL_UP}|ต่อ|ใส่)\\s*${QUEUE_WORD}(?:\\s*เพลง)?)(.*)$`,
  "is",
);

// <wake> แสดงคิว | ดูคิว | โชว์คิว | เช็คคิว | เปิดคิว | คิวมีอะไรบ้าง
const QUEUE_SHOW_RE = new RegExp(
  `${PREFIX}(?:(?:แสดง|โชว์|show|ดู|เช็ค|เช็ก|เปิด)\\s*${QUEUE_WORD}|${QUEUE_WORD}(?:เพลง)?\\s*มีอะไร)`,
  "i",
);

// <wake> ลบคิว [ที่] <N>   |   ลบ[เพลง]ที่ <N>
const QUEUE_REMOVE_A_RE = new RegExp(
  `${PREFIX}(?:ลบ|ยกเลิก)\\s*${QUEUE_WORD}(?:\\s*เพลง)?\\s*(?:ลำดับที่|ลำดับ|หมายเลข|เบอร์|อันที่|ที่)?\\s*(.*)$`,
  "is",
);
const QUEUE_REMOVE_B_RE = new RegExp(
  `${PREFIX}(?:ลบ|ยกเลิก)\\s*(?:เพลง\\s*)?(?:ลำดับที่|ลำดับ|หมายเลข|เบอร์|ที่)\\s*(.*)$`,
  "is",
);

const TH_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
const TH_ONES: Record<string, number> = {
  หนึ่ง: 1, เอ็ด: 1, สอง: 2, ยี่: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9,
};
const TH_NUM_RE =
  /^(?:((?:หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|ยี่)\s*)?สิบ\s*)?(เอ็ด|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า)?/;

/**
 * Reads a queue number from the START of `s`: "3", "๓", "สาม", "สิบเอ็ด",
 * "ยี่สิบสอง"... Returns null when there is none (or it is 0 / > 99).
 */
export function parseQueueNumber(s: string): number | null {
  const t = s
    .normalize("NFC")
    .trim()
    .replace(/[๐-๙]/g, (c) => String(TH_DIGITS.indexOf(c)));
  const d = /^(\d{1,2})(?!\d)/.exec(t);
  if (d) {
    const n = Number(d[1]);
    return n >= 1 ? n : null;
  }
  const m = TH_NUM_RE.exec(t);
  if (!m || !m[0]) return null;
  const hasTen = m[0].includes("สิบ");
  const mult = m[1] ? (TH_ONES[m[1].trim()] ?? 1) : 1;
  const ones = m[2] ? (TH_ONES[m[2]] ?? 0) : 0;
  const n = hasTen ? mult * 10 + ones : ones;
  return n >= 1 ? n : null;
}

function cleanQuery(raw: string): string {
  let q = raw.replace(LEADING_FILLER, "");
  q = q.replace(TRAILING_FILLER, "").trim();
  if (q.length > MAX_QUERY_LEN) q = q.slice(0, MAX_QUERY_LEN).trim();
  return q;
}

export type MusicCommand =
  | { kind: "play"; query: string }
  | { kind: "stop" }
  | { kind: "volume"; delta: number }
  | { kind: "kick" }
  | { kind: "skip" }
  | { kind: "queue-add"; query: string }
  | { kind: "queue-show" }
  | { kind: "queue-remove"; index: number };

/** Returns "play" for "earth/jarvis เปิดเพลง ...", "stop" for "earth/jarvis เงียบ", "kick" for "earth/jarvis เตะผม", otherwise null. */
export function parseVoiceCommand(text: string): MusicCommand | null {
  const norm = text.normalize("NFC");
  if (KICK_RE.test(norm)) return { kind: "kick" };
  if (STOP_RE.test(norm)) return { kind: "stop" };
  if (SKIP_RE.test(norm)) return { kind: "skip" };
  const v = VOLUME_RE.exec(norm);
  if (v) return { kind: "volume", delta: v[1] ? VOLUME_STEP : -VOLUME_STEP };

  const rm = QUEUE_REMOVE_A_RE.exec(norm) ?? QUEUE_REMOVE_B_RE.exec(norm);
  if (rm) {
    const index = parseQueueNumber(rm[1] ?? "");
    return index ? { kind: "queue-remove", index } : null; // "ลบคิว" with no number → do nothing
  }
  const qa = QUEUE_ADD_RE.exec(norm);
  if (qa) {
    const query = cleanQuery(qa[1] ?? "");
    return query ? { kind: "queue-add", query } : null;
  }
  if (QUEUE_SHOW_RE.test(norm)) return { kind: "queue-show" };

  const m = COMMAND_RE.exec(norm);
  if (!m) return null;

  const q = cleanQuery(m[1] ?? "");
  if (!q) return null; // "earth/jarvis เปิดเพลง" with no song name → do nothing
  return { kind: "play", query: q };
}
