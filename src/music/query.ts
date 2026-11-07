/**
 * Turns a spoken song request into YouTube search text, and picks the right result.
 *
 * Why this exists: "Annie ของ Web2Earth" used to be sent to YouTube as-is. The Thai word
 * "ของ" ("of") is just noise to YouTube, Whisper had misheard the artist, and the bot played
 * the first result (a different song by the same band). Now we:
 *   1. fix artists Whisper keeps mishearing (ARTIST_ALIASES),
 *   2. turn "<song> ของ <artist>" into "<artist> <song>",
 *   3. only accept a result whose title really contains the song name.
 */

/** What Whisper writes → what YouTube knows. Add more as you see them in the console log. */
const ARTIST_ALIASES: [RegExp, string][] = [
  [/\bweb\s*(?:2|to|too|two)\s*earth\b/gi, "wave to earth"],
  [/\bwe[ae]ve\s*(?:2|to|too|two)\s*earth\b/gi, "wave to earth"],
  [/\bwave\s*(?:2|too|two)\s*earth\b/gi, "wave to earth"],
  [/เวฟ\s*ทู\s*เอิ?ร์?[ธทดต]/g, "wave to earth"],
  // MEYOU: Whisper writes it as Miu / MiiYu / Mee You — only when it directly follows "ของ"
  [/(ของ(?:วง|ศิลปิน|นักร้อง)?\s*)(?:miu|mii?\s*yu+|mee\s*you)\b/gi, "$1MEYOU"],
  [/\bno\s*(?:mega|make)\s*up\b/gi, "No Makeup"],
];

/** " ของ " / " ของวง " / " ของศิลปิน " with spaces around it = "by <artist>". */
const OF_RE = /\s+ของ(?:วง|ศิลปิน|นักร้อง)?\s+/g;

export interface MusicQuery {
  /** Song name (or the whole query when no artist was given). */
  song: string;
  /** Artist, when the request had the "<song> ของ <artist>" form. */
  artist: string | null;
  /** Search strings to try, best first. */
  searches: string[];
}

export function parseMusicQuery(raw: string): MusicQuery {
  let text = raw.normalize("NFC");
  for (const [re, fix] of ARTIST_ALIASES) text = text.replace(re, fix);
  text = text.replace(/\s+/g, " ").trim();

  let song = text;
  let artist: string | null = null;
  let last: RegExpMatchArray | null = null;
  for (const m of text.matchAll(OF_RE)) last = m;
  if (last && last.index !== undefined) {
    const s = text.slice(0, last.index).trim();
    const a = text.slice(last.index + last[0].length).trim();
    if (s && a) {
      song = s;
      artist = a;
    }
  }

  const searches = artist ? [`${artist} ${song}`, `${song} ${artist}`] : [text];
  return { song, artist, searches };
}

/** Lowercase, drop punctuation, keep letters/Thai marks/digits. */
function norm(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

/** True if `hay` contains the phrase (ignoring spaces), or (for multi-word phrases) every word of it. */
function has(hay: string, phrase: string): boolean {
  const p = norm(phrase);
  if (!p) return true;
  const squash = (s: string) => s.replace(/\s+/g, "");
  return (
    hay.includes(p) ||
    squash(hay).includes(squash(p)) ||
    p.split(" ").every((w) => hay.includes(w))
  );
}

export interface LavalinkCandidate {
  info: { title: string; author?: string; isStream: boolean; length: number };
}

/**
 * Pick the track to play from Lavalink's search results.
 * - No artist given → first playable result (old behavior).
 * - "<song> ของ <artist>" → the title MUST contain the song name; an artist match
 *   (in the title or channel name) wins over one without. No match → null, so the bot says
 *   "not found" instead of playing a different song.
 */
export function pickCandidate<T extends LavalinkCandidate>(
  candidates: T[],
  q: MusicQuery,
  maxMs: number,
): T | null {
  const playable = candidates.filter((t) => !t.info.isStream && t.info.length <= maxMs);
  if (!q.artist) return playable[0] ?? null;

  let best: T | null = null;
  let bestScore = 0;
  for (const t of playable) {
    if (!has(norm(t.info.title), q.song)) continue;
    const score = 10 + (has(norm(`${t.info.title} ${t.info.author ?? ""}`), q.artist) ? 5 : 0);
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}
