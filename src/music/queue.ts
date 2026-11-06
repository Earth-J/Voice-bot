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
}

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

  shift(): T | undefined {
    return this.items.shift();
  }

  /** Remove by 1-based number. Returns the removed item, or null if out of range. */
  remove(index1: number): T | null {
    if (!Number.isInteger(index1) || index1 < 1 || index1 > this.items.length) return null;
    return this.items.splice(index1 - 1, 1)[0] ?? null;
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

/** Minimal embed shape — structurally compatible with discord.js' APIEmbed. */
export interface QueueEmbed {
  title: string;
  description: string;
  color: number;
  footer?: { text: string };
}

/**
 * The live queue embed: current song + numbered queue (1 = next up).
 * Always well under Discord's 4096-char embed description limit.
 */
export function buildQueueEmbed<T extends QueueTrack>(
  now: T | null,
  queue: T[],
  maxShown = 15,
): QueueEmbed {
  const lines: string[] = [];
  lines.push(
    now
      ? `▶️ **กำลังเล่น**\n${escapeMd(clip(now.title))} \`${fmtMs(now.lengthMs)}\``
      : "▶️ ตอนนี้ไม่ได้เล่นเพลงอยู่",
  );
  lines.push("");
  if (queue.length === 0) {
    lines.push("📋 **คิว** — ว่าง");
  } else {
    lines.push(`📋 **คิว** (${queue.length})`);
    queue.slice(0, maxShown).forEach((t, i) => {
      lines.push(`\`${i + 1}.\` ${escapeMd(clip(t.title))} \`${fmtMs(t.lengthMs)}\``);
    });
    if (queue.length > maxShown) lines.push(`_…และอีก ${queue.length - maxShown} เพลง_`);
  }
  return {
    title: "🎵 คิวเพลง",
    description: lines.join("\n"),
    color: 0x5865f2,
    footer: { text: "earth เพิ่มเพลง <ชื่อ> • earth ลบคิว <เลข> • earth ข้าม • earth เงียบ" },
  };
}
