/**
 * Lavalink music backend (via Shoukaku).
 *
 * Discord allows only ONE voice connection per bot per guild. The listener bot
 * (STT, @discordjs/voice) already holds that connection, so music runs on a
 * SECOND bot account (MUSIC_BOT_TOKEN) which Lavalink connects to the same
 * voice channel on demand.
 *
 * Env:
 *   MUSIC_BOT_TOKEN        token of the second (music) bot — required
 *   LAVALINK_HOST          default "localhost:2333"
 *   LAVALINK_PASSWORD      default "youshallnotpass"
 *   LAVALINK_SECURE        "true" for wss/https
 *   LAVALINK_SEARCH_PREFIX default "ytsearch:" (needs the youtube-source plugin)
 *   MUSIC_VOLUME           starting volume 0–1, default 0.5 (voice commands change it ±5%)
 *   MUSIC_MAX_MINUTES      skip results longer than this (default 20)
 *   MUSIC_MAX_QUEUE        max songs waiting in the queue per server (default 50);
 *                          also the most a pasted playlist can add
 */
import { Client, Events, GatewayIntentBits } from "discord.js";
import { Connectors, Shoukaku, type Player } from "shoukaku";
import { TrackQueue, type LoopMode } from "./queue.ts";

export type { LoopMode } from "./queue.ts";
import { filterPlayable, parseMusicQuery, pickCandidate } from "./query.ts";

const HOST = process.env.LAVALINK_HOST || "localhost:2333";
const PASSWORD = process.env.LAVALINK_PASSWORD || "youshallnotpass";
const SECURE = process.env.LAVALINK_SECURE === "true";
const SEARCH_PREFIX = process.env.LAVALINK_SEARCH_PREFIX || "ytsearch:";
const MAX_MS = (Number(process.env.MUSIC_MAX_MINUTES) || 20) * 60_000;
const MAX_QUEUE = Number(process.env.MUSIC_MAX_QUEUE) || 50;
const envVolume = Number(process.env.MUSIC_VOLUME);
/** Lavalink volume is in percent (100 = normal). Default starting volume. */
const DEFAULT_VOLUME_PCT = Math.round(
  (process.env.MUSIC_VOLUME && Number.isFinite(envVolume)
    ? Math.min(Math.max(envVolume, 0), 1)
    : 0.5) * 100,
);

export interface Track {
  title: string;
  uri?: string;
  lengthMs: number;
  /** Source id (e.g. YouTube video id). Stable across Lavalink events, unlike `encoded`. */
  identifier?: string;
  /** Lavalink-encoded track data (what actually gets played). */
  encoded: string;
  /** Channel / artist name, when the source provides one (e.g. the YouTube channel). */
  author?: string;
  /** Thumbnail / album-art URL. Lavalink (youtube-source) fills this in from the video itself. */
  artworkUrl?: string;
  /** True for livestreams — `lengthMs` isn't a real duration then. */
  isStream?: boolean;
  /** e.g. "youtube". Lets the UI say where a track came from without guessing from the URL. */
  sourceName?: string;
  /** Discord user id of whoever asked for it (voice command / typed in the music room). */
  requestedBy?: string;
}

/** What happened to a pasted playlist (see LavalinkMusic.enqueue). */
export interface PlaylistInfo {
  name: string;
  /** Songs that made it in (the one that started right away + the ones queued). */
  added: number;
  /** Playable songs left out because the queue was full. */
  dropped: number;
  /** Songs left out because they can't be played (livestream, longer than MUSIC_MAX_MINUTES). */
  skipped: number;
}

/** Lavalink track (search / load result) → our Track. */
function toTrack(c: any): Track {
  return {
    title: c.info.title,
    uri: c.info.uri,
    lengthMs: c.info.length,
    identifier: c.info.identifier,
    encoded: c.encoded,
    author: c.info.author,
    artworkUrl: c.info.artworkUrl,
    isStream: c.info.isStream,
    sourceName: c.info.sourceName,
  };
}

/** How many already-played songs the ⏮ button can walk back through. */
const HISTORY_MAX = 20;

export class LavalinkMusic {
  readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  private shoukaku: Shoukaku;
  private now = new Map<string, Track>();
  /** Epoch ms when the current song started. Used only to draw a progress bar. */
  private startedAt = new Map<string, number>();
  /** Per-guild volume in percent (0–100); survives across songs. */
  private volume = new Map<string, number>();
  /** Bumped on every play()/stop()/leave() so a slow search can't override a newer request. */
  private req = new Map<string, number>();
  private hooked = new WeakSet<Player>();
  /** Called whenever the current song or the queue changes (used to refresh the queue embed). */
  onChange: ((guildId: string) => void) | null = null;
  /** Called when a request found nothing playable (or the queue was full). */
  onNotFound: ((guildId: string) => void) | null = null;
  /** Called when the queue just ran down to its last song (that song starts playing now, nothing queued after it). */
  onLastSong: ((guildId: string) => void) | null = null;
  /** Called when a song ended on its own and there is nothing left — no queue, nothing playing. */
  onQueueEmpty: ((guildId: string) => void) | null = null;
  /** Songs waiting after the current one (1 = next up). */
  private queues = new Map<string, TrackQueue<Track>>();
  /** Epoch ms when playback was paused (present = paused). */
  private pausedAt = new Map<string, number>();
  /** Per-guild loop mode. */
  private loops = new Map<string, LoopMode>();
  /** Songs that played before the current one, oldest first (for ⏮). */
  private history = new Map<string, Track[]>();
  /** The song most recently started — moves into `history` when the next one starts. */
  private lastStarted = new Map<string, Track>();

  constructor() {
    this.shoukaku = new Shoukaku(
      new Connectors.DiscordJS(this.client),
      [{ name: "main", url: HOST, auth: PASSWORD, secure: SECURE }],
      { moveOnDisconnect: false, resume: false, reconnectTries: 5, restTimeout: 15_000 },
    );
    // Unhandled 'error' events would crash the process.
    this.shoukaku.on("error", (name, e) =>
      console.warn(`[lavalink] node ${name} error:`, e?.message ?? e),
    );
    this.shoukaku.on("ready", (name) => console.log(`[lavalink] node ${name} ready`));
    this.shoukaku.on("close", (name, code, reason) =>
      console.warn(`[lavalink] node ${name} closed (${code}) ${reason ?? ""}`),
    );
    this.shoukaku.on("disconnect", (name) =>
      console.warn(`[lavalink] node ${name} disconnected`),
    );
    this.client.once(Events.ClientReady, (c) =>
      console.log(`[lavalink] music bot logged in as ${c.user.tag}`),
    );
  }

  async start(token: string): Promise<void> {
    await this.client.login(token);
  }

  private bump(guildId: string): number {
    const id = (this.req.get(guildId) ?? 0) + 1;
    this.req.set(guildId, id);
    return id;
  }

  getVolume(guildId: string): number {
    return this.volume.get(guildId) ?? DEFAULT_VOLUME_PCT;
  }

  /** Change volume by `delta` percent (clamped to 0–100). Returns the new volume. */
  async changeVolume(guildId: string, delta: number): Promise<number> {
    const next = Math.min(100, Math.max(0, this.getVolume(guildId) + delta));
    this.volume.set(guildId, next);
    const player = this.shoukaku.players.get(guildId);
    if (player) await player.setGlobalVolume(next);
    console.log(`[music] volume → ${next}%`);
    this.changed(guildId); // the player embed shows the volume
    return next;
  }

  nowPlaying(guildId: string): Track | null {
    return this.now.get(guildId) ?? null;
  }

  /** Epoch ms when the current song started; null if nothing is playing. */
  playingSince(guildId: string): number | null {
    return this.startedAt.get(guildId) ?? null;
  }

  /** How far into the current song we are (frozen while paused); null if nothing is playing. */
  positionMs(guildId: string): number | null {
    const started = this.startedAt.get(guildId);
    if (started === undefined) return null;
    return Math.max(0, (this.pausedAt.get(guildId) ?? Date.now()) - started);
  }

  isPaused(guildId: string): boolean {
    return this.pausedAt.has(guildId);
  }

  getLoop(guildId: string): LoopMode {
    return this.loops.get(guildId) ?? "none";
  }

  /** none → track → queue → none. Returns the new mode. */
  cycleLoop(guildId: string): LoopMode {
    const order: LoopMode[] = ["none", "track", "queue"];
    const next = order[(order.indexOf(this.getLoop(guildId)) + 1) % order.length]!;
    this.loops.set(guildId, next);
    console.log(`[music] loop → ${next}`);
    this.changed(guildId);
    return next;
  }

  isPlaying(guildId: string): boolean {
    return this.now.has(guildId);
  }

  /**
   * Set the current track and stamp when it started. The song that was started before it
   * moves into the history (unless `pushHistory` is false: ⏮ and loop-this-song replays).
   */
  private setNowPlaying(guildId: string, track: Track, pushHistory = true): void {
    const last = this.lastStarted.get(guildId);
    if (pushHistory && last && last !== track) {
      let h = this.history.get(guildId);
      if (!h) this.history.set(guildId, (h = []));
      h.push(last);
      if (h.length > HISTORY_MAX) h.shift();
    }
    this.lastStarted.set(guildId, track);
    this.now.set(guildId, track);
    this.startedAt.set(guildId, Date.now());
    this.pausedAt.delete(guildId); // a new song always starts un-paused
  }

  /** Clear the current track (ended / stopped / failed). */
  private clearNowPlaying(guildId: string): void {
    this.now.delete(guildId);
    this.startedAt.delete(guildId);
    this.pausedAt.delete(guildId);
  }

  private changed(guildId: string): void {
    try {
      this.onChange?.(guildId);
    } catch (e) {
      console.warn("[music] onChange handler threw:", e);
    }
  }

  private notFound(guildId: string): void {
    try {
      this.onNotFound?.(guildId);
    } catch (e) {
      console.warn("[music] onNotFound handler threw:", e);
    }
  }

  private lastSong(guildId: string): void {
    try {
      this.onLastSong?.(guildId);
    } catch (e) {
      console.warn("[music] onLastSong handler threw:", e);
    }
  }

  private queueEmpty(guildId: string): void {
    try {
      this.onQueueEmpty?.(guildId);
    } catch (e) {
      console.warn("[music] onQueueEmpty handler threw:", e);
    }
  }

  private queueFor(guildId: string): TrackQueue<Track> {
    let q = this.queues.get(guildId);
    if (!q) {
      q = new TrackQueue<Track>(MAX_QUEUE);
      this.queues.set(guildId, q);
    }
    return q;
  }

  getQueue(guildId: string): Track[] {
    return this.queues.get(guildId)?.list() ?? [];
  }

  /** Remove queue item #`index` (1 = next up). Returns the removed track or null. */
  removeFromQueue(guildId: string, index: number): Track | null {
    const removed = this.queues.get(guildId)?.remove(index) ?? null;
    if (removed) this.changed(guildId);
    return removed;
  }

  /**
   * Search YouTube and return the best playable result (no streams, not too long).
   * "<song> ของ <artist>" is rewritten to "<artist> <song>" and the result's title must
   * contain the song name (see music/query.ts).
   * A YouTube video link is loaded directly instead of searched (no "ytsearch:" prefix).
   */
  private async search(query: string): Promise<Track | null> {
    const node = this.shoukaku.getIdealNode();
    if (!node) throw new Error("Lavalink ยังไม่พร้อม (ยังไม่ได้เชื่อมต่อ node)");

    const q = parseMusicQuery(query);
    // A playlist link given to a "play now" request: play its first song (enqueue() takes all of it).
    if (q.playlistUrl) return (await this.loadPlaylist(q.playlistUrl))?.tracks[0] ?? null;
    for (const text of q.searches) {
      const res: any = await node.rest.resolve(q.directUrl ? text : `${SEARCH_PREFIX}${text}`);
      if (!res || res.loadType === "error") {
        throw new Error(`Lavalink load failed: ${res?.data?.message ?? "unknown"}`);
      }
      const candidates: any[] =
        res.loadType === "search" ? res.data : res.loadType === "track" ? [res.data] : [];
      const picked = pickCandidate(candidates, q, MAX_MS);
      if (picked) return toTrack(picked);
      console.log(`[music] no match for "${text}"`);
    }
    return null;
  }

  /**
   * Load a YouTube playlist link. Returns its playable songs (no streams, none longer than
   * MUSIC_MAX_MINUTES) in playlist order, or null when it is empty / has nothing playable.
   */
  private async loadPlaylist(
    url: string,
  ): Promise<{ name: string; tracks: Track[]; skipped: number } | null> {
    const node = this.shoukaku.getIdealNode();
    if (!node) throw new Error("Lavalink ยังไม่พร้อม (ยังไม่ได้เชื่อมต่อ node)");

    const res: any = await node.rest.resolve(url);
    if (!res || res.loadType === "error") {
      throw new Error(`Lavalink load failed: ${res?.data?.message ?? "unknown"}`);
    }
    if (res.loadType !== "playlist") return null;

    const all: any[] = res.data?.tracks ?? [];
    const tracks = filterPlayable(all, MAX_MS).map(toTrack);
    if (tracks.length === 0) {
      console.log(`[music] playlist ${url}: nothing playable (${all.length} tracks)`);
      return null;
    }
    return { name: String(res.data?.info?.name ?? ""), tracks, skipped: all.length - tracks.length };
  }

  /**
   * Playlist link: nothing playing → its first song starts now and the rest queue up behind it;
   * otherwise every song is appended to the queue. Stops when the queue is full.
   * Returns null when nothing playable was found / nothing fit in the queue.
   */
  private async enqueuePlaylist(
    guildId: string,
    channelId: string,
    url: string,
    requestedBy?: string,
  ): Promise<{ track: Track; position: number; playlist: PlaylistInfo } | null> {
    const pl = await this.loadPlaylist(url);
    if (!pl) {
      this.notFound(guildId);
      return null;
    }
    const tracks = pl.tracks.map((t) => ({ ...t, requestedBy }));
    const first = tracks[0]!;

    let position: number | null = null; // where `first` ended up (0 = playing now)
    let startedNow = false;
    if (!this.now.has(guildId)) {
      const id = this.bump(guildId);
      const player = await this.ensurePlayer(guildId, channelId);
      // A newer request (or another song) may have taken over while the player was joining.
      if (id === this.req.get(guildId) && !this.now.has(guildId)) {
        this.hook(guildId, player);
        await this.startTrack(guildId, player, tracks.shift()!);
        startedNow = true;
        position = 0;
      }
    }

    const q = this.queueFor(guildId);
    let queued = 0;
    for (const t of tracks) {
      const pos = q.push(t);
      if (pos === null) break; // queue full
      position ??= pos;
      queued++;
    }
    if (queued > 0) this.changed(guildId);

    if (position === null) {
      console.warn(`[music] queue full (${MAX_QUEUE}) — dropped playlist "${pl.name}"`);
      this.notFound(guildId);
      return null;
    }
    const added = queued + (startedNow ? 1 : 0);
    console.log(`[music] 📃 playlist "${pl.name}": ${added}/${pl.tracks.length} songs added`);
    return {
      track: first,
      position,
      playlist: {
        name: pl.name,
        added,
        dropped: pl.tracks.length - added,
        skipped: pl.skipped,
      },
    };
  }

  /** Get the guild's player, joining `channelId` with the music bot if needed. */
  private async ensurePlayer(guildId: string, channelId: string): Promise<Player> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      throw new Error("บอทเพลงยังไม่ได้อยู่ในเซิร์ฟเวอร์นี้ — เชิญ MUSIC bot เข้าเซิร์ฟเวอร์ก่อน");
    }
    let player = this.shoukaku.players.get(guildId);
    if (!player) {
      player = await this.shoukaku.joinVoiceChannel({
        guildId,
        channelId,
        shardId: guild.shardId,
        deaf: true,
      });
    }
    return player;
  }

  private async startTrack(
    guildId: string,
    player: Player,
    track: Track,
    opts: { pushHistory?: boolean } = {},
  ): Promise<void> {
    await player.setGlobalVolume(this.getVolume(guildId));
    // paused:false — Lavalink keeps the player's paused flag across songs, so a song started
    // while paused (skip / ⏮ / next in queue) would otherwise stay silent.
    await player.playTrack({ track: { encoded: track.encoded }, paused: false });
    this.setNowPlaying(guildId, track, opts.pushHistory ?? true);
    console.log(`[music] ▶ ${track.title} (${track.uri ?? "?"})`);
    this.changed(guildId);
  }

  /**
   * Search and play the top result NOW in `channelId` (the music bot joins it if needed).
   * Replaces the current song; the queue is kept.
   * Returns the track, or null if nothing playable was found / a newer request won.
   */
  async play(
    guildId: string,
    channelId: string,
    query: string,
    requestedBy?: string,
  ): Promise<Track | null> {
    const id = this.bump(guildId);

    const track = await this.search(query);
    if (track) track.requestedBy = requestedBy;
    if (id !== this.req.get(guildId)) return null;
    if (!track) {
      this.notFound(guildId);
      return null;
    }

    const player = await this.ensurePlayer(guildId, channelId);
    if (id !== this.req.get(guildId)) return null;
    this.hook(guildId, player);

    await this.startTrack(guildId, player, track);
    return track;
  }

  /**
   * "เพิ่มเพลง": nothing playing → play it now (position 0); otherwise append to the
   * queue. Returns the track and its position (0 = playing now, N = Nth in queue),
   * or null if nothing playable was found / the queue is full.
   * A playlist link adds the whole playlist (see enqueuePlaylist); `playlist` is then set and
   * `track`/`position` describe its first song.
   */
  async enqueue(
    guildId: string,
    channelId: string,
    query: string,
    requestedBy?: string,
  ): Promise<{ track: Track; position: number; playlist?: PlaylistInfo } | null> {
    const pq = parseMusicQuery(query);
    if (pq.playlistUrl) return this.enqueuePlaylist(guildId, channelId, pq.playlistUrl, requestedBy);

    if (!this.now.has(guildId)) {
      const track = await this.play(guildId, channelId, query, requestedBy);
      return track ? { track, position: 0 } : null;
    }

    const track = await this.search(query);
    if (!track) {
      this.notFound(guildId);
      return null;
    }
    track.requestedBy = requestedBy;
    const position = this.queueFor(guildId).push(track);
    if (position === null) {
      console.warn(`[music] queue full (${MAX_QUEUE}) — dropped "${track.title}"`);
      this.notFound(guildId);
      return null;
    }
    console.log(`[music] ➕ queued #${position}: ${track.title}`);
    this.changed(guildId);

    // The current song may have ended while we were searching → nothing would pick this up.
    if (!this.now.has(guildId)) {
      const player = this.shoukaku.players.get(guildId);
      if (player) {
        this.hook(guildId, player);
        const started = await this.advance(guildId);
        if (started) return { track, position: 0 };
      }
    }
    return { track, position };
  }

  /**
   * Start the next queued song. Returns false when the queue is empty.
   * `natural` = the previous song ended on its own (not a skip / enqueue): only then is the
   * "last song" sound announced, so it doesn't fight with the skip / play sounds.
   */
  private async advance(guildId: string, natural = false): Promise<boolean> {
    const q = this.queues.get(guildId);
    const player = this.shoukaku.players.get(guildId);
    if (!q || !player) return false;
    const next = q.shift();
    if (!next) return false;
    try {
      await this.startTrack(guildId, player, next);
      // That was the last queued song → tell the user it's the final one (not with loop: it never runs out).
      if (natural && q.length === 0 && this.getLoop(guildId) === "none") this.lastSong(guildId);
      return true;
    } catch (e: any) {
      console.warn(`[music] could not start queued "${next.title}":`, e?.message ?? e);
      this.clearNowPlaying(guildId);
      this.changed(guildId);
      return this.advance(guildId, natural); // try the one after it
    }
  }

  /**
   * Skip the current song: jump to the next queued one, or stop if the queue is empty.
   * Returns what was skipped (null if nothing was playing) and what plays now (null if none).
   */
  async skip(guildId: string): Promise<{ skipped: Track | null; next: Track | null }> {
    const skipped = this.now.get(guildId) ?? null;
    if (!skipped) return { skipped: null, next: null };
    // Loop-queue: the skipped song goes to the back of the line instead of being dropped.
    if (this.getLoop(guildId) === "queue") this.queueFor(guildId).push(skipped);
    const started = await this.advance(guildId); // old song ends as 'replaced' → ignored
    if (!started) {
      await this.stop(guildId);
      return { skipped, next: null };
    }
    return { skipped, next: this.now.get(guildId) ?? null };
  }

  /** ⏯ Pause / resume. Returns the new paused state, or null when nothing is playing. */
  async togglePause(guildId: string): Promise<boolean | null> {
    const player = this.shoukaku.players.get(guildId);
    if (!player || !this.now.has(guildId)) return null;
    const pause = !this.pausedAt.has(guildId);
    await player.setPaused(pause);
    if (pause) {
      this.pausedAt.set(guildId, Date.now());
    } else {
      // Push the start time forward by the time spent paused, so positionMs() keeps counting
      // from where it stopped.
      const since = this.pausedAt.get(guildId) ?? Date.now();
      this.startedAt.set(guildId, (this.startedAt.get(guildId) ?? Date.now()) + (Date.now() - since));
      this.pausedAt.delete(guildId);
    }
    console.log(`[music] ${pause ? "⏸ paused" : "▶ resumed"}`);
    this.changed(guildId);
    return pause;
  }

  /** 🔀 Shuffle the queue (not the current song). Returns false when the queue has < 2 songs. */
  shuffleQueue(guildId: string): boolean {
    const done = this.queues.get(guildId)?.shuffle() ?? false;
    if (done) this.changed(guildId);
    return done;
  }

  /**
   * ⏮ Go back to the song that played before. The current song is put at the front of the
   * queue so nothing is lost. Returns the song now playing, or null when there is no history.
   */
  async previous(guildId: string): Promise<Track | null> {
    const player = this.shoukaku.players.get(guildId);
    const h = this.history.get(guildId);
    if (!player || !h || h.length === 0) return null;
    const prev = h.pop()!;
    this.bump(guildId); // a slow search for an older request must not override this
    const cur = this.now.get(guildId);
    if (cur) this.queueFor(guildId).unshift(cur);
    try {
      await this.startTrack(guildId, player, prev, { pushHistory: false });
    } catch (e) {
      h.push(prev); // couldn't start it — keep it for another try
      if (cur) this.queues.get(guildId)?.remove(1);
      throw e;
    }
    return prev;
  }

  /** Stop the current song AND clear the queue; the music bot stays in the channel. */
  async stop(guildId: string): Promise<void> {
    this.bump(guildId);
    this.clearNowPlaying(guildId);
    this.queues.get(guildId)?.clear();
    this.changed(guildId);
    const player = this.shoukaku.players.get(guildId);
    if (player) await player.stopTrack().catch(() => {});
  }

  /** Stop and leave the voice channel. */
  async leave(guildId: string): Promise<void> {
    this.bump(guildId);
    this.clearNowPlaying(guildId);
    this.queues.get(guildId)?.clear();
    this.history.delete(guildId);
    this.lastStarted.delete(guildId);
    this.loops.delete(guildId);
    this.changed(guildId);
    if (!this.shoukaku.players.has(guildId)) return;
    try {
      await this.shoukaku.leaveVoiceChannel(guildId);
    } catch (e: any) {
      console.warn("[lavalink] leave failed:", e?.message ?? e);
    }
  }

  private hook(guildId: string, player: Player): void {
    if (this.hooked.has(player)) return;
    this.hooked.add(player);

    // Ignore events about a song that is no longer the current one.
    // NOTE: compare the track *identifier*, not `encoded`. Lavalink re-encodes the track
    // for events and the encoding includes the playback position, so on 'finished' the
    // string never equals the one we started with → every natural end looked "stale"
    // and the queue never advanced.
    const isStale = (ev: any): boolean => {
      const cur = this.now.get(guildId);
      const evId = ev?.track?.info?.identifier;
      return !!cur && !!cur.identifier && !!evId && cur.identifier !== evId;
    };
    // Natural end → next song. When there is none (and nothing is playing) → "no songs left" sound.
    const advanceLogged = (): Promise<boolean> =>
      this.advance(guildId, true)
        .catch((e: any) => {
          console.warn("[music] advance failed:", e?.message ?? e);
          return false;
        })
        .then((started) => {
          if (!started && !this.now.has(guildId)) this.queueEmpty(guildId);
          return started;
        });

    player.on("end", (ev: any) => {
      const reason = String(ev?.reason ?? "").toLowerCase();
      const stale = isStale(ev);
      console.log(`[music] end event: reason=${reason} stale=${stale} queue=${this.getQueue(guildId).length}`);
      // 'replaced' = a newer song took over — don't clear its "now playing".
      if (reason === "replaced" || stale) return;
      // Loop: only when the song really finished (not on loadFailed, or a broken song would repeat forever).
      const cur = this.now.get(guildId);
      if (reason === "finished" && cur) {
        const mode = this.getLoop(guildId);
        if (mode === "track") {
          this.startTrack(guildId, player, cur, { pushHistory: false }).catch((e: any) =>
            console.warn("[music] loop replay failed:", e?.message ?? e),
          );
          return;
        }
        if (mode === "queue") this.queueFor(guildId).push(cur); // back of the line, then advance
      }
      this.clearNowPlaying(guildId);
      this.changed(guildId);
      // Song ended on its own (or failed to load) → next in the queue.
      // 'stopped' (stop/clear) and 'cleanup' deliberately do NOT advance.
      if (reason === "finished" || reason === "loadfailed") void advanceLogged();
    });
    player.on("exception", (ev: any) => {
      console.warn("[lavalink] track exception:", ev?.exception?.message ?? ev);
      this.clearNowPlaying(guildId); // the following 'end' (loadFailed) moves on
      this.changed(guildId);
    });
    player.on("stuck", (ev: any) => {
      if (isStale(ev)) return;
      this.clearNowPlaying(guildId);
      this.changed(guildId);
      void advanceLogged()
        .then((started) => (started ? undefined : player.stopTrack()))
        .catch(() => {});
    });
    player.on("closed", () => {
      this.clearNowPlaying(guildId);
      this.queues.get(guildId)?.clear();
      this.changed(guildId);
    });
  }
}
