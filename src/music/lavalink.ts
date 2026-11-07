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
 *   MUSIC_MAX_QUEUE        max songs waiting in the queue per server (default 50)
 */
import { Client, Events, GatewayIntentBits } from "discord.js";
import { Connectors, Shoukaku, type Player } from "shoukaku";
import { TrackQueue } from "./queue.ts";

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
}

export class LavalinkMusic {
  readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  private shoukaku: Shoukaku;
  private now = new Map<string, Track>();
  /** Per-guild volume in percent (0–100); survives across songs. */
  private volume = new Map<string, number>();
  /** Bumped on every play()/stop()/leave() so a slow search can't override a newer request. */
  private req = new Map<string, number>();
  private hooked = new WeakSet<Player>();
  /** Called whenever the current song or the queue changes (used to refresh the queue embed). */
  onChange: ((guildId: string) => void) | null = null;
  /** Called when a request found nothing playable (or the queue was full). */
  onNotFound: ((guildId: string) => void) | null = null;
  /** Songs waiting after the current one (1 = next up). */
  private queues = new Map<string, TrackQueue<Track>>();

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
    return next;
  }

  nowPlaying(guildId: string): Track | null {
    return this.now.get(guildId) ?? null;
  }

  isPlaying(guildId: string): boolean {
    return this.now.has(guildId);
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

  /** Search YouTube and return the first playable result (no streams, not too long). */
  private async search(query: string): Promise<Track | null> {
    const node = this.shoukaku.getIdealNode();
    if (!node) throw new Error("Lavalink ยังไม่พร้อม (ยังไม่ได้เชื่อมต่อ node)");

    const res: any = await node.rest.resolve(`${SEARCH_PREFIX}${query}`);
    if (!res || res.loadType === "error") {
      throw new Error(`Lavalink load failed: ${res?.data?.message ?? "unknown"}`);
    }
    const candidates: any[] =
      res.loadType === "search" ? res.data : res.loadType === "track" ? [res.data] : [];
    const picked = candidates.find((t) => !t.info.isStream && t.info.length <= MAX_MS);
    if (!picked) {
      console.log(`[music] no playable result for "${query}"`);
      return null;
    }
    return {
      title: picked.info.title,
      uri: picked.info.uri,
      lengthMs: picked.info.length,
      identifier: picked.info.identifier,
      encoded: picked.encoded,
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

  private async startTrack(guildId: string, player: Player, track: Track): Promise<void> {
    await player.setGlobalVolume(this.getVolume(guildId));
    await player.playTrack({ track: { encoded: track.encoded } });
    this.now.set(guildId, track);
    console.log(`[music] ▶ ${track.title} (${track.uri ?? "?"})`);
    this.changed(guildId);
  }

  /**
   * Search and play the top result NOW in `channelId` (the music bot joins it if needed).
   * Replaces the current song; the queue is kept.
   * Returns the track, or null if nothing playable was found / a newer request won.
   */
  async play(guildId: string, channelId: string, query: string): Promise<Track | null> {
    const id = this.bump(guildId);

    const track = await this.search(query);
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
   */
  async enqueue(
    guildId: string,
    channelId: string,
    query: string,
  ): Promise<{ track: Track; position: number } | null> {
    if (!this.now.has(guildId)) {
      const track = await this.play(guildId, channelId, query);
      return track ? { track, position: 0 } : null;
    }

    const track = await this.search(query);
    if (!track) {
      this.notFound(guildId);
      return null;
    }
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

  /** Start the next queued song. Returns false when the queue is empty. */
  private async advance(guildId: string): Promise<boolean> {
    const q = this.queues.get(guildId);
    const player = this.shoukaku.players.get(guildId);
    if (!q || !player) return false;
    const next = q.shift();
    if (!next) return false;
    try {
      await this.startTrack(guildId, player, next);
      return true;
    } catch (e: any) {
      console.warn(`[music] could not start queued "${next.title}":`, e?.message ?? e);
      this.now.delete(guildId);
      this.changed(guildId);
      return this.advance(guildId); // try the one after it
    }
  }

  /**
   * Skip the current song: jump to the next queued one, or stop if the queue is empty.
   * Returns what was skipped (null if nothing was playing) and what plays now (null if none).
   */
  async skip(guildId: string): Promise<{ skipped: Track | null; next: Track | null }> {
    const skipped = this.now.get(guildId) ?? null;
    if (!skipped) return { skipped: null, next: null };
    const started = await this.advance(guildId); // old song ends as 'replaced' → ignored
    if (!started) {
      await this.stop(guildId);
      return { skipped, next: null };
    }
    return { skipped, next: this.now.get(guildId) ?? null };
  }

  /** Stop the current song AND clear the queue; the music bot stays in the channel. */
  async stop(guildId: string): Promise<void> {
    this.bump(guildId);
    this.now.delete(guildId);
    this.queues.get(guildId)?.clear();
    this.changed(guildId);
    const player = this.shoukaku.players.get(guildId);
    if (player) await player.stopTrack().catch(() => {});
  }

  /** Stop and leave the voice channel. */
  async leave(guildId: string): Promise<void> {
    this.bump(guildId);
    this.now.delete(guildId);
    this.queues.get(guildId)?.clear();
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
    const advanceLogged = () =>
      this.advance(guildId).catch((e: any) =>
        console.warn("[music] advance failed:", e?.message ?? e),
      );

    player.on("end", (ev: any) => {
      const reason = String(ev?.reason ?? "").toLowerCase();
      const stale = isStale(ev);
      console.log(`[music] end event: reason=${reason} stale=${stale} queue=${this.getQueue(guildId).length}`);
      // 'replaced' = a newer song took over — don't clear its "now playing".
      if (reason === "replaced" || stale) return;
      this.now.delete(guildId);
      this.changed(guildId);
      // Song ended on its own (or failed to load) → next in the queue.
      // 'stopped' (stop/clear) and 'cleanup' deliberately do NOT advance.
      if (reason === "finished" || reason === "loadfailed") void advanceLogged();
    });
    player.on("exception", (ev: any) => {
      console.warn("[lavalink] track exception:", ev?.exception?.message ?? ev);
      this.now.delete(guildId); // the following 'end' (loadFailed) moves on
      this.changed(guildId);
    });
    player.on("stuck", (ev: any) => {
      if (isStale(ev)) return;
      this.now.delete(guildId);
      this.changed(guildId);
      void this.advance(guildId)
        .then((started) => (started ? undefined : player.stopTrack()))
        .catch(() => {});
    });
    player.on("closed", () => {
      this.now.delete(guildId);
      this.queues.get(guildId)?.clear();
      this.changed(guildId);
    });
  }
}
