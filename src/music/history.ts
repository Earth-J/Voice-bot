/**
 * Song history (SQLite) — remembers what each server has already played, so a repeat request
 * picks the exact same video instead of whatever YouTube search happens to rank first.
 *
 * Uses Bun's built-in SQLite (`bun:sqlite`), so there is nothing extra to install. The file lives
 * in DATA_DIR (default ./data) — on Railway that folder needs a Volume, same as setup.json.
 *
 * Tables
 *   tracks     one row per YouTube video ever played (title / channel / length / link)
 *   plays      one row per play: which server, which video, what was asked, who asked, when
 *   query_map  "what people typed" → "which video it turned out to be", with a hit counter
 *   rejects    (request, video) pairs that were skipped within seconds = wrong pick, don't reuse
 *
 * Lookup order (lookup()):
 *   1. exact  — the same request (after the artist-alias fixes in query.ts) was played here before
 *   2. fuzzy  — a played title contains the song name AND the artist ("<song> ของ <artist>"),
 *               or, with no artist, exactly one played title contains a fairly long song name.
 * Anything unsure returns null and the normal YouTube search runs, as before.
 *
 * Every method swallows its own database errors: history is a bonus, it must never stop a song.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { has, norm, type MusicQuery } from "./query.ts";

const VIDEO_ID_RE = /^[\w-]{11}$/;

export interface HistoryTrack {
  videoId: string;
  uri: string;
  title: string;
  author: string | null;
  lengthMs: number;
  artworkUrl: string | null;
}

export interface HistoryMatch {
  track: HistoryTrack;
  how: "exact" | "fuzzy";
  /** How many times this server has played that video. */
  plays: number;
}

/** What recordPlay needs from a played track (a subset of lavalink.ts `Track`). */
export interface PlayInput {
  identifier?: string;
  uri?: string;
  title: string;
  author?: string;
  lengthMs: number;
  artworkUrl?: string;
  isStream?: boolean;
  sourceName?: string;
  requestedBy?: string;
  /** Key of the request that led to this song (see queryKey). */
  queryKey?: string;
}

export interface PlayRecord {
  videoId: string;
  title: string;
  author: string | null;
  requestedBy: string | null;
  playedAt: number;
}

/** Same request ⇒ same key: "Annie ของ Web2Earth" and "wave to earth annie" both end up here. */
export function queryKey(q: Pick<MusicQuery, "song" | "artist">): string {
  return norm(q.artist ? `${q.artist} ${q.song}` : q.song);
}

const squash = (s: string) => s.replace(/\s+/g, "");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  video_id        TEXT PRIMARY KEY,
  uri             TEXT NOT NULL,
  title           TEXT NOT NULL,
  author          TEXT,
  length_ms       INTEGER NOT NULL,
  artwork_url     TEXT,
  first_played_at INTEGER NOT NULL,
  last_played_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plays (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  video_id     TEXT NOT NULL,
  query_key    TEXT,
  requested_by TEXT,
  played_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_guild_video ON plays (guild_id, video_id);
CREATE INDEX IF NOT EXISTS plays_guild_time  ON plays (guild_id, played_at);
CREATE TABLE IF NOT EXISTS query_map (
  guild_id    TEXT NOT NULL,
  query_key   TEXT NOT NULL,
  video_id    TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 1,
  last_hit_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, query_key, video_id)
);
CREATE TABLE IF NOT EXISTS rejects (
  guild_id  TEXT NOT NULL,
  query_key TEXT NOT NULL,
  video_id  TEXT NOT NULL,
  PRIMARY KEY (guild_id, query_key, video_id)
);
`;

interface TrackRow {
  video_id: string;
  uri: string;
  title: string;
  author: string | null;
  length_ms: number;
  artwork_url: string | null;
  plays?: number;
}

function toHistoryTrack(r: TrackRow): HistoryTrack {
  return {
    videoId: r.video_id,
    uri: r.uri,
    title: r.title,
    author: r.author,
    lengthMs: r.length_ms,
    artworkUrl: r.artwork_url,
  };
}

export class MusicHistory {
  private db: Database;

  /** `file` = path of the .db file, or ":memory:" (tests). */
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * A song just started playing here. Stores the video, the play, and (when it came from a
   * request) the request → video link. Livestreams and non-YouTube sources are ignored.
   */
  recordPlay(guildId: string, t: PlayInput, now = Date.now()): void {
    const id = t.identifier;
    if (!id || !VIDEO_ID_RE.test(id) || t.isStream) return;
    if (t.sourceName && t.sourceName.toLowerCase() !== "youtube") return;
    try {
      const uri = t.uri || `https://www.youtube.com/watch?v=${id}`;
      const key = t.queryKey || null;
      this.db.transaction(() => {
        this.db
          .query(
            `INSERT INTO tracks (video_id, uri, title, author, length_ms, artwork_url, first_played_at, last_played_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(video_id) DO UPDATE SET
               uri = excluded.uri, title = excluded.title, author = excluded.author,
               length_ms = excluded.length_ms,
               artwork_url = COALESCE(excluded.artwork_url, tracks.artwork_url),
               last_played_at = excluded.last_played_at`,
          )
          .run(id, uri, t.title, t.author ?? null, Math.round(t.lengthMs), t.artworkUrl ?? null, now);
        this.db
          .query(
            `INSERT INTO plays (guild_id, video_id, query_key, requested_by, played_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(guildId, id, key, t.requestedBy ?? null, now);
        if (key) {
          this.db
            .query(
              `INSERT INTO query_map (guild_id, query_key, video_id, hits, last_hit_at) VALUES (?1, ?2, ?3, 1, ?4)
               ON CONFLICT(guild_id, query_key, video_id) DO UPDATE SET hits = hits + 1, last_hit_at = excluded.last_hit_at`,
            )
            .run(guildId, key, id, now);
          // Picked again and played → give it another chance (the early skip may just have been a mood).
          this.db
            .query(`DELETE FROM rejects WHERE guild_id = ? AND query_key = ? AND video_id = ?`)
            .run(guildId, key, id);
        }
      })();
    } catch (e: any) {
      console.warn("[history] recordPlay failed:", e?.message ?? e);
    }
  }

  /**
   * The song was skipped within seconds: whatever the request resolved to was probably wrong.
   * Forget the link, and keep the video from being suggested for that request again.
   */
  reject(guildId: string, key: string, videoId: string): void {
    if (!key || !videoId) return;
    try {
      this.db.transaction(() => {
        this.db
          .query(`DELETE FROM query_map WHERE guild_id = ? AND query_key = ? AND video_id = ?`)
          .run(guildId, key, videoId);
        this.db
          .query(`INSERT OR IGNORE INTO rejects (guild_id, query_key, video_id) VALUES (?, ?, ?)`)
          .run(guildId, key, videoId);
      })();
      console.log(`[history] ✗ rejected ${videoId} for "${key}"`);
    } catch (e: any) {
      console.warn("[history] reject failed:", e?.message ?? e);
    }
  }

  /**
   * Which already-played video does this request mean? null = no confident answer (search YouTube).
   * Links (direct video / playlist) are never looked up — they already say exactly what to play.
   * `maxMs` drops videos longer than the bot is willing to play.
   */
  lookup(guildId: string, q: MusicQuery, maxMs = Number.MAX_SAFE_INTEGER): HistoryMatch | null {
    if (q.directUrl || q.playlistUrl) return null;
    const key = queryKey(q);
    if (!key) return null;
    try {
      const exact = this.db
        .query(
          `SELECT t.*, (SELECT COUNT(*) FROM plays p WHERE p.guild_id = ?1 AND p.video_id = t.video_id) AS plays
           FROM query_map m JOIN tracks t ON t.video_id = m.video_id
           WHERE m.guild_id = ?1 AND m.query_key = ?2 AND t.length_ms <= ?3
             AND NOT EXISTS (SELECT 1 FROM rejects r
                             WHERE r.guild_id = m.guild_id AND r.query_key = m.query_key AND r.video_id = m.video_id)
           ORDER BY m.hits DESC, m.last_hit_at DESC LIMIT 1`,
        )
        .get(guildId, key, maxMs) as TrackRow | null;
      if (exact) return { track: toHistoryTrack(exact), how: "exact", plays: exact.plays ?? 1 };

      const rejected = new Set(
        (
          this.db
            .query(`SELECT video_id FROM rejects WHERE guild_id = ? AND query_key = ?`)
            .all(guildId, key) as { video_id: string }[]
        ).map((r) => r.video_id),
      );
      const rows = this.db
        .query(
          `SELECT t.*, COUNT(p.id) AS plays, MAX(p.played_at) AS last
           FROM plays p JOIN tracks t ON t.video_id = p.video_id
           WHERE p.guild_id = ?1 AND t.length_ms <= ?2
           GROUP BY t.video_id ORDER BY last DESC LIMIT 2000`,
        )
        .all(guildId, maxMs) as (TrackRow & { last: number })[];

      const byTitle = rows.filter((r) => !rejected.has(r.video_id) && has(norm(r.title), q.song));
      if (q.artist) {
        const artist = q.artist;
        const both = byTitle.filter((r) => has(norm(`${r.title} ${r.author ?? ""}`), artist));
        // Most played wins; rows are already newest-first, so ties go to the most recent.
        let best: (TrackRow & { last: number }) | null = null;
        for (const r of both) if (!best || (r.plays ?? 0) > (best.plays ?? 0)) best = r;
        return best ? { track: toHistoryTrack(best), how: "fuzzy", plays: best.plays ?? 1 } : null;
      }
      // No artist: only trust a fairly specific name that matches exactly one played video.
      if (squash(norm(q.song)).length < 6 || byTitle.length !== 1) return null;
      const only = byTitle[0]!;
      return { track: toHistoryTrack(only), how: "fuzzy", plays: only.plays ?? 1 };
    } catch (e: any) {
      console.warn("[history] lookup failed:", e?.message ?? e);
      return null;
    }
  }

  /** Newest first — for a future "/earth history" style command. */
  recent(guildId: string, limit = 20): PlayRecord[] {
    try {
      return (
        this.db
          .query(
            `SELECT t.video_id, t.title, t.author, p.requested_by, p.played_at
             FROM plays p JOIN tracks t ON t.video_id = p.video_id
             WHERE p.guild_id = ? ORDER BY p.id DESC LIMIT ?`,
          )
          .all(guildId, limit) as any[]
      ).map((r) => ({
        videoId: r.video_id,
        title: r.title,
        author: r.author,
        requestedBy: r.requested_by,
        playedAt: r.played_at,
      }));
    } catch (e: any) {
      console.warn("[history] recent failed:", e?.message ?? e);
      return [];
    }
  }
}
