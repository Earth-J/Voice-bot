/**
 * Pure queue helpers (no Discord / Lavalink imports) so they are easy to test.
 *
 * The queue holds the songs that come AFTER the one currently playing,
 * numbered from 1 (1 = next up). "ลบคิว 2" removes item #2 of this list.
 */

export interface QueueTrack {
  title: string;
  uri?: string;
  lengthMs: number;
  /** Source id (the YouTube video id for YouTube tracks) — used for the thumbnail. */
  identifier?: string;
  /** Channel / artist name, when the source provides one. */
  author?: string;
  /** Discord user id of whoever asked for the song (shown as "ขอเพลง โดย @user"). */
  requestedBy?: string;
  /** Name of the voice channel the requester was in when they asked — captured at request time. */
  voiceChannelName?: string;
  /** Livestream — `lengthMs` isn't a real duration then. */
  isStream?: boolean;
}

export type LoopMode = "none" | "track" | "queue";

export class TrackQueue<T> {
  private items: T[] = [];

  constructor(private readonly max = 50) {}

  get length(): number {
    return this.items.length;
  }

  /** Copy of the queue, next-up first. */
  list(): T[] {
    return [...this.items];
  }

  /** Append. Returns the 1-based position, or null when the queue is full. */
  push(t: T): number | null {
    if (this.items.length >= this.max) return null;
    this.items.push(t);
    return this.items.length;
  }

  /** Put a song at the very front (next up). If that overfills the queue, the last song falls off. */
  unshift(t: T): void {
    this.items.unshift(t);
    if (this.items.length > this.max) this.items.pop();
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  /** Remove by 1-based number. Returns the removed item, or null if out of range. */
  remove(index1: number): T | null {
    if (!Number.isInteger(index1) || index1 < 1 || index1 > this.items.length) return null;
    return this.items.splice(index1 - 1, 1)[0] ?? null;
  }

  /** Fisher–Yates shuffle in place. Returns false when there is nothing to shuffle (< 2 songs). */
  shuffle(random: () => number = Math.random): boolean {
    if (this.items.length < 2) return false;
    for (let i = this.items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [this.items[i], this.items[j]] = [this.items[j]!, this.items[i]!];
    }
    return true;
  }

  clear(): void {
    this.items = [];
  }
}

function fmtMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function clip(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function escapeMd(s: string): string {
  return s.replace(/[\\*_`~|>\[\]]/g, "\\$&");
}

/**
 * "Invisible embed": the colour strip on the embed's left edge is set to Discord's dark-theme
 * embed background (#2b2d31), so the strip disappears and the embed reads as a clean panel.
 * On the light theme it shows as a faint grey strip — that's the usual trade-off of this trick.
 * Only `buildQueueListEmbed` (the ephemeral 📋 popup) still uses it — the main player panel
 * (`buildPlayerSections`) is a Components V2 container now, with no embed and so no strip on any theme.
 */
export const INVISIBLE_EMBED_COLOR = 0x2b2d31;

/** Minimal embed shape — structurally compatible with discord.js' APIEmbed. */
export interface QueueEmbed {
  title: string;
  url?: string;
  description: string;
  color: number;
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
}

export interface PlayerContentOptions {
  /** Max queue lines to show (default 5 — the 📋 button shows the whole list). */
  maxShown?: number;
  /** Current volume in percent (no longer shown on the panel — the 🔉/🔊 buttons change it). */
  volumePct?: number;
  /** Loop mode (default "none"). */
  loop?: LoopMode;
  /** Playback is paused. */
  paused?: boolean;
  /** The panel lives in the /earth setup channel, where typing a song name plays it. */
  setupChannel?: boolean;
}

const LOOP_LABELS: Record<LoopMode, string> = {
  none: "ปิด",
  track: "เพลงนี้",
  queue: "ทั้งคิว",
};
export const loopLabel = (m: LoopMode): string => LOOP_LABELS[m];

/** YouTube thumbnail for a track, or undefined for other sources. */
export function thumbnailFor(t: QueueTrack): string | undefined {
  if (!t.identifier || !t.uri || !/(?:youtube\.com|youtu\.be)/i.test(t.uri)) return undefined;
  return `https://i.ytimg.com/vi/${encodeURIComponent(t.identifier)}/hqdefault.jpg`;
}

/** "`1.` Title `3:20`" lines for the first `maxShown` songs, plus a "…and N more" line. */
export function queueLines(queue: QueueTrack[], maxShown = 15): string[] {
  const lines = queue
    .slice(0, maxShown)
    .map((t, i) => `\`${i + 1}.\` ${escapeMd(clip(t.title))} \`${fmtMs(t.lengthMs)}\``);
  if (queue.length > maxShown) lines.push(`_…และอีก ${queue.length - maxShown} เพลง_`);
  return lines;
}

/** Full queue for the 📋 button (sent as an ephemeral reply): current song + up to 25 numbered songs. */
export function buildQueueListEmbed<T extends QueueTrack>(now: T | null, queue: T[]): QueueEmbed {
  const lines: string[] = [];
  lines.push(
    now
      ? `▶️ **กำลังเล่น**\n${escapeMd(clip(now.title))} \`${fmtMs(now.lengthMs)}\``
      : "ตอนนี้ไม่ได้เล่นเพลงอยู่",
  );
  lines.push("");
  if (queue.length === 0) {
    lines.push("📋 **คิว** — ว่าง");
  } else {
    lines.push(`📋 **คิว** (${queue.length})`);
    lines.push(...queueLines(queue, 25));
  }
  lines.push("");
  lines.push("ลบเพลงในคิว: พูด `earth ลบคิว <เลข>`");
  return { title: "🎵 คิวเพลง", description: lines.join("\n"), color: INVISIBLE_EMBED_COLOR };
}

/** Same content as `buildQueueListEmbed`, as markdown text for a Components V2 TextDisplay. */
export function buildQueueListText<T extends QueueTrack>(now: T | null, queue: T[]): string {
  const e = buildQueueListEmbed(now, queue);
  return `### ${e.title}\n${e.description}`;
}

/** Custom emoji shown in front of the voice-channel name, and on the idle "waiting for a song" title. The bot has to be able to use it (same server, or "Use External Emoji"). */
export const VOICE_EMOJI = "<:6211screensharevolumemax:1569251810135244800>";

/** Custom emoji shown in front of the title of the song that is playing (the player panel's heading). Same rule as VOICE_EMOJI: the bot must be able to use it. */
export const NOW_PLAYING_EMOJI = "<:4767voiceevent:1569242043107115118>";

/** Idle-panel hint inside the /earth setup channel, where typing a song name plays it. */
const IDLE_TIP = "พิมพ์ชื่อเพลงในห้องนี้ได้เลย — หรือจะสั่งด้วยเสียงก็ได้";

/**
 * The player panel's text, kept minimal on purpose. While a song is playing:
 *
 *   ## <emoji> Song title                 heading (NOW_PLAYING_EMOJI + title)
 *   Artist                                regular size (prefix with "-# " for smaller)
 *   ────────────────────                  divider
 *   -# ขอเพลง โดย @user ใน 🔊 ห้อง          subtext: small + muted
 *   -# ⏸️ หยุดชั่วคราว · 🔁 เพลงนี้ · 🔉 80%     only the parts that aren't the default
 *
 * then the next few songs (if any) and a small footer with the command hints.
 *
 * Nothing playing (nobody has asked for a song yet):
 *
 *   ## 🔊 กำลังรอเพลง
 *   ────────────────────
 *   -# พิมพ์ชื่อเพลงในห้องนี้ได้เลย — หรือจะสั่งด้วยเสียงก็ได้
 *
 * (Outside the setup channel typing doesn't play anything, so the last line is the command hints instead.)
 * The "────" rule above is NOT drawn with characters any more: the function returns the text in
 * sections (one string each), and index.ts puts a real Components V2 Separator between them.
 * Returns 1 section when there is no divider to draw (e.g. a playing song with no extra info).
 * Plain markdown only, so each section works inside a Components V2 TextDisplay.
 */
export function buildPlayerSections<T extends QueueTrack>(
  now: T | null,
  queue: T[],
  opts: PlayerContentOptions = {},
): string[] {
  const { maxShown = 5, loop = "none", paused = false, setupChannel = false } = opts;

  const hints = "earth เพิ่มเพลง <ชื่อ> • earth ลบคิว <เลข> • earth ข้าม • earth เงียบ";
  // Text above the divider (title / artist) and below it (small muted info, queue, footer).
  const head: string[] = [];
  const tail: string[] = [];
  let divider = false;

  if (now) {
    // The title is the only heading — plain text, not a link — with the emoji in front of it.
    head.push(`## ${NOW_PLAYING_EMOJI} ${escapeMd(clip(now.title, 80))}`);
    if (now.author) head.push(escapeMd(clip(now.author, 60)));

    // Everything under the divider is small, and only what is worth knowing gets shown.
    const meta: string[] = [];
    if (now.requestedBy) {
      const where = now.voiceChannelName
        ? ` ใน ${VOICE_EMOJI} ${escapeMd(clip(now.voiceChannelName, 40))}`
        : "";
      meta.push(`-# ขอเพลง โดย <@${now.requestedBy}>${where}`);
    }
    const state: string[] = [];
    if (paused) state.push("⏸️ หยุดชั่วคราว");
    if (loop !== "none") state.push(`🔁 ${loopLabel(loop)}`);
    if (state.length > 0) meta.push(`-# ${state.join(" · ")}`);
    if (meta.length > 0) {
      divider = true;
      tail.push(...meta);
    }
  } else {
    head.push(`## ${VOICE_EMOJI} กำลังรอเพลง`);
    divider = true;
    tail.push(`-# ${setupChannel ? IDLE_TIP : hints}`);
  }

  if (queue.length > 0) {
    tail.push("", `-# 📋 คิว (${queue.length})`, ...queueLines(queue, maxShown));
  }

  // TextDisplay caps at 4000 chars across the whole message — clip defensively, `maxShown` keeps this far below it.
  const clipText = (s: string) => (s.length > 1900 ? `${s.slice(0, 1899)}…` : s);
  const headText = clipText(head.join("\n"));
  const tailText = clipText(tail.join("\n").trim());

  if (!tailText) return [headText];
  return divider ? [headText, tailText] : [clipText(`${headText}\n${tailText}`)];
}
