#!/usr/bin/env bun
/**
 * Earth Voice Bot — STT + YouTube music
 *
 * Joins a Discord voice channel and listens (Whisper STT). Earth is silent
 * unless someone says:
 *
 *     "earth เปิดเพลง <ชื่อเพลง>"   (or "earth เงียบ" / "earth เงียบหน่อย" to stop)
 *
 * in which case a SECOND bot (MUSIC_BOT_TOKEN) joins the same channel and plays
 * the top YouTube result through Lavalink. (One bot can hold only one voice
 * connection per guild, so listening and playing use separate accounts.)
 * Nothing that is said is saved or posted anywhere.
 *
 * Slash commands (owner-only, see DC_OWNER_IDS — except /earth join, which anyone can use
 * for the voice channel they are sitting in; the channel-id option stays owner-only):
 *   /earth join [channel-id]  — join the caller's voice channel
 *   /earth leave              — leave (stops music)
 *   /earth stop               — stop the current song
 *   /earth status             — session state, now playing, STT usage
 *   /earth stay [hours]       — disable auto-leave for a while (max 24h)
 *   /earth unstay             — re-enable auto-leave
 *   /earth setup [channel-id] — set the music room (default: the channel you type it in)
 *   /earth unsetup            — remove the music room
 *
 * Earth only listens to LISTEN_USER_IDS (default: one specific user); voice
 * commands come only from them. Voice: "earth เพิ่มเสียง" / "earth เบาเสียง" = ±5%.
 * Voice: "earth เตะผม" = disconnect the speaker from the voice channel
 * (needs the Move Members permission for the listener bot).
 *
 * Queue (all by voice):
 *   "earth เพิ่มเพลง <ชื่อเพลง>"  — add to queue (plays now if nothing is playing)
 *   "earth ข้าม" / "earth skip" — skip to the next song (stops if queue is empty)
 *   "earth ลบคิว <เลขลำดับ>"       — remove item #N from the queue (1 = next up)
 *   "earth แสดงคิว"               — re-post the queue embed at the bottom of the channel
 * A live queue embed lives in QUEUE_CHANNEL_ID (text channel): it is created when a song
 * starts, edited whenever the queue / current song changes, and deleted when playback
 * ends. "เงียบ" (or "stop") stops the song, clears the queue and deletes the embed.
 *
 * Music room (/earth setup [channel-id]):
 *   - typing a song name in that text channel plays it (or queues it if something is
 *     playing) — no prefix, no wake word. Needs the Message Content intent.
 *   - the player embed (also for voice commands) is kept in that channel instead of
 *     QUEUE_CHANNEL_ID, as ONE permanent message that is edited — it flips to an idle
 *     panel when nothing is playing instead of being deleted.
 *   - /earth unsetup removes it. Saved in DATA_DIR/setup.json (survives restarts).
 *
 * Player panel: a Components V2 message — one container holding the blurred-cover card
 *   (music/nowPlayingCard.ts, attached as a file), the text, and two rows of buttons
 *   (music/controls.ts) — no embed at all, so there's no colour strip on any theme: 🔀 shuffle · ⏮ previous · ⏯ pause · ⏭ next · 🔁 loop /
 *   📋 queue · 🔉 vol− · ⏹ stop · 🔊 vol+. Buttons only work for people in Earth's voice
 *   channel (or owners). (The 📋 queue button replies with an ephemeral
 *   Components V2 container — see music/queue.ts's `buildQueueListText`.)
 *
 * Auto-leave: as soon as no human is left in the channel, Earth leaves
 * (after a short grace, ALONE_LEAVE_DELAY_MS) — unless /earth stay is on.
 *
 * Run:
 *   bun src/index.ts          (foreground)
 *   bun --watch src/index.ts  (dev)
 */
import path from "node:path";
import {
  AttachmentBuilder,
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  PermissionsBitField,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type ButtonInteraction,
  type Message,
  type VoiceState,
  type ChatInputCommandInteraction,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
// sodium-native: required for Discord's AEAD encryption (xchacha20poly1305_ietf).
// tweetnacl alone doesn't support it → packets get dropped silently → 0 chunks captured.
import "sodium-native";
import { VoiceSession, formatDuration, type SpeechEvent } from "./voice-session.ts";
import { YOI_BASE_NAMES, ALIAS_TO_SUBCOMMAND } from "./commands.ts";
import { parseVoiceCommand } from "./voice-command.ts";
import { correctSongQuery } from "./stt/gemini.ts";
import { sttConfigError, sttSummary } from "./stt/index.ts";
import { LavalinkMusic } from "./music/lavalink.ts";
import { MusicHistory } from "./music/history.ts";
import { loadSfx } from "./sfx.ts";
import { buildPlayerSections, buildQueueListText } from "./music/queue.ts";
import { renderIdleCard, renderNowPlaying } from "./music/nowPlayingCard.ts";
import { CONTROL_ID, CONTROL_PREFIX, VOLUME_STEP, buildControlRows } from "./music/controls.ts";
import { parseSongRequest } from "./music/request.ts";
import { SetupStore } from "./setup-store.ts";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("[earth-voice] DISCORD_TOKEN missing in .env");
  process.exit(1);
}
const musicToken = process.env.MUSIC_BOT_TOKEN;
if (!musicToken) {
  console.error("[earth-voice] MUSIC_BOT_TOKEN missing in .env (second bot used for Lavalink playback)");
  process.exit(1);
}
const sttError = sttConfigError();
if (sttError) {
  console.error(`[earth-voice] ${sttError}`);
  process.exit(1);
}

const OWNER_IDS = new Set(
  (process.env.DC_OWNER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (OWNER_IDS.size === 0) {
  console.warn(
    "[earth-voice] ⚠️ DC_OWNER_IDS is empty — owner-only slash commands (everything except /earth join) will be ignored for ALL users",
  );
}

/**
 * Slash subcommands anyone can run. Everything else is owner-only.
 * Non-owners get a restricted /earth join (see handleJoin): only in a server, only into the
 * voice channel they are sitting in — never a channel picked by id.
 */
const PUBLIC_SUBCOMMANDS = new Set(["join"]);

// Only these users are listened to (everyone else's audio is ignored entirely).
const LISTEN_USER_IDS = new Set(
  (process.env.LISTEN_USER_IDS ?? "918384557131173988")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const AUTO_LEAVE_ALONE_MS = Number(process.env.AUTO_LEAVE_ALONE_MS) || 5 * 60 * 1000;
// Leave this long after the last human leaves the channel (small grace so a
// quick channel switch / reconnect does not make Earth bounce). 0 = instantly.
const ALONE_LEAVE_DELAY_MS = Number(process.env.ALONE_LEAVE_DELAY_MS ?? 2000);
// Text channel for the live queue embed (the listener bot needs View + Send Messages there).
const QUEUE_CHANNEL_ID = process.env.QUEUE_CHANNEL_ID ?? "954104906149687306";
const MEMORY_REPORT_MS = Number(process.env.MEMORY_REPORT_MS) || 10 * 60 * 1000;
const SILENCE_THRESHOLD_MS = Number(process.env.SILENCE_THRESHOLD_MS) || 1500;
const STAY_MAX_HOURS = Number(process.env.STAY_MAX_HOURS) || 24;

const client = new Client({
  // GuildMessages + MessageContent: read song names typed in the /earth setup channel.
  // MessageContent is a PRIVILEGED intent — enable "Message Content Intent" for this bot in the
  // Discord Developer Portal (Bot tab), otherwise login fails with "Used disallowed intents".
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Music rooms set with /earth setup (guildId → channel + persistent embed message).
const setupStore = new SetupStore(path.join(process.env.DATA_DIR || "data", "setup.json"));
setupStore.load();
// Delete the typed request after handling it, so the player embed stays at the bottom.
// Needs Manage Messages in the setup channel; set SETUP_DELETE_MESSAGES=false to keep them.
const SETUP_DELETE_MESSAGES = process.env.SETUP_DELETE_MESSAGES !== "false";

// Song history (SQLite in DATA_DIR/music-history.db): remembers what was played so repeat requests
// pick the same video. Set MUSIC_HISTORY=false to turn it off. Never fatal — without it the bot
// just searches YouTube every time, as before.
let musicHistory: MusicHistory | null = null;
if (process.env.MUSIC_HISTORY !== "false") {
  try {
    musicHistory = new MusicHistory(path.join(process.env.DATA_DIR || "data", "music-history.db"));
  } catch (e: any) {
    console.warn("[history] could not open the song history database — continuing without it:", e?.message ?? e);
  }
}
const music = new LavalinkMusic(musicHistory);
const sessions = new Map<string, VoiceSession>();
const aloneSince = new Map<string, number>(); // guildId → ms when bot became alone

const FALLBACK_GUILD_ID = process.env.DISCORD_GUILD_ID;

/**
 * Resolve which guild to act on for non-join commands:
 *   1. interaction.guildId (when called from a guild channel)
 *   2. The first guild with an active session
 *   3. DISCORD_GUILD_ID fallback (single-guild default)
 */
function resolveActiveGuildId(interaction: ChatInputCommandInteraction): string | null {
  if (interaction.guildId) return interaction.guildId;
  for (const [gid, s] of sessions) {
    if (s.state !== "idle") return gid;
  }
  return FALLBACK_GUILD_ID ?? null;
}

function sessionFor(guildId: string): VoiceSession {
  let s = sessions.get(guildId);
  if (!s) {
    s = new VoiceSession();
    sessions.set(guildId, s);
  }
  return s;
}

client.once(Events.ClientReady, (c) => {
  console.log(`[earth-voice] Earth ready — logged in as ${c.user.tag} (id=${c.user.id})`);
  console.log(`[earth-voice] In ${c.guilds.cache.size} guild(s); slash commands handled per-guild`);
  console.log(
    `[earth-voice] config: auto-leave-alone=${AUTO_LEAVE_ALONE_MS}ms ` +
      `listening-to=${[...LISTEN_USER_IDS].join(",") || "everyone"}`,
  );
  startAutoLeaveWatcher();
  startPersistentCapWatcher();
  startMemoryReporter();
  startCardTicker();
  // After a restart nothing is playing: bring every music room's panel back to "idle"
  // (or re-create it if someone deleted it while the bot was offline).
  for (const gid of setupStore.guildIds()) {
    void runQueueUi(gid, () => refreshQueueEmbed(gid));
  }
});

// ─── Voice commands ──────────────────────────────────────────────────────────
// Earth never answers in voice or text. A recognised command just starts music;
// anything else that was said is dropped.
async function handleSpeech(session: VoiceSession, ev: SpeechEvent): Promise<void> {
  let cmd = parseVoiceCommand(ev.text);
  if (!cmd) return;
  if (session.state !== "listening" || !session.guildId || !session.channelId) return;

  // Only song names go through Gemini (fixes words Whisper mis-heard). Never throws;
  // on timeout / quota / no key it returns the original text, so this adds no risk.
  if (cmd.kind === "play" || cmd.kind === "queue-add") {
    const fixed = await correctSongQuery(cmd.query);
    if (fixed !== cmd.query) cmd = { ...cmd, query: fixed };
    // The session may have ended while we waited for Gemini.
    if (session.state !== "listening" || !session.guildId || !session.channelId) return;
  }

  if (cmd.kind === "kick") {
    console.log(`[earth-voice] 🥾 voice command from user=${ev.userId}: kick me`);
    kickSpeaker(session.guildId, ev.userId).catch((e: any) => {
      console.warn(`[earth-voice] kick failed for user=${ev.userId}:`, e?.message ?? e);
    });
    return;
  }

  if (cmd.kind === "skip") {
    music
      .skip(session.guildId)
      .then((r) => {
        console.log(
          `[earth-voice] ⏭️ voice command from user=${ev.userId}: skip → ` +
            (r.skipped ? `"${r.skipped.title}" skipped, now ${r.next ? `"${r.next.title}"` : "nothing"}` : "nothing was playing"),
        );
        if (r.skipped) session.playSfx("skip");
      })
      .catch((e: any) => console.warn("[earth-voice] skip failed:", e?.message ?? e));
    return;
  }

  if (cmd.kind === "queue-add") {
    console.log(`[earth-voice] ➕ voice command from user=${ev.userId}: queue add "${cmd.query}"`);
    music
      .enqueue(session.guildId, session.channelId, cmd.query, ev.userId)
      .then((r) => {
        // position 0 = nothing was playing, so it started right away
        if (r) session.playSfx(r.position === 0 ? "play" : "add");
      })
      .catch((e: any) => {
        console.warn(`[earth-voice] queue add failed for "${cmd.query}":`, e?.message ?? e);
        session.playSfx("notfound");
      });
    return;
  }

  if (cmd.kind === "queue-remove") {
    const removed = music.removeFromQueue(session.guildId, cmd.index);
    console.log(
      `[earth-voice] 🗑️ voice command from user=${ev.userId}: queue remove #${cmd.index} → ` +
        (removed ? `"${removed.title}"` : "no such item"),
    );
    session.playSfx(removed ? "remove" : "notfound");
    return;
  }

  if (cmd.kind === "queue-show") {
    console.log(`[earth-voice] 📋 voice command from user=${ev.userId}: show queue`);
    runQueueUi(session.guildId!, () => repostQueueEmbed(session.guildId!));
    return;
  }

  if (cmd.kind === "volume") {
    console.log(`[earth-voice] 🔊 voice command from user=${ev.userId}: volume ${cmd.delta > 0 ? "+" : ""}${cmd.delta}`);
    music.changeVolume(session.guildId, cmd.delta).catch((e: any) => {
      console.warn("[earth-voice] volume change failed:", e?.message ?? e);
    });
    return;
  }

  if (cmd.kind === "stop") {
    console.log(`[earth-voice] 🎵 voice command from user=${ev.userId}: stop`);
    const wasActive = music.isPlaying(session.guildId) || music.getQueue(session.guildId).length > 0;
    music
      .stop(session.guildId)
      .then(() => {
        if (wasActive) session.playSfx("stop");
      })
      .catch((e: any) => {
        console.warn("[earth-voice] stop failed:", e?.message ?? e);
      });
    return;
  }

  console.log(`[earth-voice] 🎵 voice command from user=${ev.userId}: play "${cmd.query}"`);
  music
    .play(session.guildId, session.channelId, cmd.query, ev.userId)
    .then((track) => {
      if (track) session.playSfx("play");
    })
    .catch((e: any) => {
      console.warn(`[earth-voice] play failed for "${cmd.query}":`, e?.message ?? e);
      session.playSfx("notfound");
    });
}

// ─── Live queue embed ────────────────────────────────────────────────────────
// One embed message per guild in QUEUE_CHANNEL_ID. Created when music starts,
// edited on every queue / now-playing change, deleted when nothing is left.
const queueMessages = new Map<string, Message>();
const queueRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const queueUiChains = new Map<string, Promise<void>>();
const setupChains = new Map<string, Promise<void>>();

/** Run `fn` strictly after the previous job with the same key. Never rejects (errors are logged). */
function serial(
  chains: Map<string, Promise<void>>,
  key: string,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn).catch((e: any) => {
    console.warn(`[earth-voice] ${label}:`, e?.message ?? e);
  });
  chains.set(key, next);
  return next;
}

/** Run embed work for a guild strictly one at a time (so we never post two embeds). */
function runQueueUi(guildId: string, fn: () => Promise<void>): Promise<void> {
  return serial(queueUiChains, guildId, "queue embed update failed", fn);
}

/** Coalesce bursts of changes (play + advance + ...) into one embed update. */
function scheduleQueueRefresh(guildId: string): void {
  if (queueRefreshTimers.has(guildId)) return;
  queueRefreshTimers.set(
    guildId,
    setTimeout(() => {
      queueRefreshTimers.delete(guildId);
      void runQueueUi(guildId, () => refreshQueueEmbed(guildId));
    }, 250),
  );
}

/** Where the player embed goes: the /earth setup channel if there is one, else QUEUE_CHANNEL_ID. */
function embedChannelId(guildId: string): string {
  return setupStore.get(guildId)?.channelId ?? QUEUE_CHANNEL_ID;
}

async function getQueueChannel(guildId: string) {
  const id = embedChannelId(guildId);
  const ch = await client.channels.fetch(id).catch((e: any) => {
    console.warn(`[earth-voice] cannot fetch queue channel ${id}:`, e?.message ?? e);
    return null;
  });
  if (!ch || !ch.isSendable()) {
    console.warn(`[earth-voice] queue channel ${id} is missing or not a text channel`);
    return null;
  }
  return ch;
}

/** Remember a freshly posted embed (and, in a music room, its message id for after a restart). */
function trackEmbed(guildId: string, msg: Message): void {
  queueMessages.set(guildId, msg);
  const entry = setupStore.get(guildId);
  if (entry && entry.messageId !== msg.id) {
    setupStore.set(guildId, { channelId: entry.channelId, messageId: msg.id });
  }
}

/** The live embed message: the cached one, or (music room) the one saved before a restart. */
async function findEmbedMessage(guildId: string): Promise<Message | null> {
  const cached = queueMessages.get(guildId);
  if (cached) return cached;
  const savedId = setupStore.get(guildId)?.messageId;
  if (!savedId) return null;
  const ch = await getQueueChannel(guildId);
  if (!ch) return null;
  const msg = await ch.messages.fetch(savedId).catch(() => null); // deleted meanwhile → null
  if (msg) queueMessages.set(guildId, msg);
  return msg;
}

async function deleteQueueEmbed(guildId: string): Promise<void> {
  const msg = await findEmbedMessage(guildId);
  queueMessages.delete(guildId);
  const entry = setupStore.get(guildId);
  if (entry?.messageId) setupStore.set(guildId, { channelId: entry.channelId });
  if (!msg) return;
  await msg.delete().catch(() => {}); // already gone / no permission → nothing to do
}

async function queuePayload(guildId: string) {
  const np = music.nowPlaying(guildId);
  const paused = music.isPaused(guildId);
  const loop = music.getLoop(guildId);

  // Blurred-cover card, rendered from the song's artwork. If rendering fails the message
  // is still sent, just without the picture (no embed to fall back on, either way).
  const files: AttachmentBuilder[] = [];
  try {
    // Nothing playing → the static "Waiting for a song…" card instead.
    const card = np
      ? await renderNowPlaying(np, music.positionMs(guildId) ?? 0, { paused })
      : await renderIdleCard();
    files.push(new AttachmentBuilder(card, { name: "nowplaying.png" }));
  } catch (e: any) {
    console.warn("[earth-voice] now-playing card render failed:", e?.message ?? e);
  }

  // "ขอเพลง โดย @user ใน 🔊 ห้อง" — the room is the voice channel the bot is sitting in.
  let shown = np;
  if (np) {
    const name = client.guilds.cache.get(guildId)?.members.me?.voice.channel?.name;
    if (name) shown = { ...np, voiceChannelName: name };
  }

  const sections = buildPlayerSections(shown, music.getQueue(guildId), {
    volumePct: music.getVolume(guildId),
    loop,
    paused,
    setupChannel: setupStore.get(guildId) !== undefined,
  });

  // Components V2 layout: ONE container holding the text, the card picture and the buttons.
  // No accent colour is set, so there is no colour strip on any theme.
  // (V2 messages can't carry `content` / `embeds`; the IsComponentsV2 flag is mandatory.)
  const container = new ContainerBuilder();

  // Text in sections with a real Separator line between them (instead of a row of "─" characters).
  sections.forEach((text, idx) => {
    if (idx > 0) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  });

  if (files.length > 0) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL("attachment://nowplaying.png"),
      ),
    );
  }

  // Thin divider between the card picture and the button rows.
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  // Buttons are always shown; with nothing playing they are all greyed out / unclickable.
  container.addActionRowComponents(
    ...buildControlRows({ paused, loop, disabled: !np }),
  );

  return {
    components: [container],
    files,
    // `as const` keeps the literal type — discord.js only accepts these flags on create/edit.
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: { parse: [] as never[] },
  };
}

/**
 * Make the embed match the current music state.
 *  - normal channel (QUEUE_CHANNEL_ID): create / edit / delete when nothing is left
 *  - music room (/earth setup): one permanent message — create / edit, never delete;
 *    it shows an idle panel when nothing is playing
 */
async function refreshQueueEmbed(guildId: string): Promise<void> {
  const inMusicRoom = setupStore.get(guildId) !== undefined;
  const idle = !music.nowPlaying(guildId) && music.getQueue(guildId).length === 0;
  if (idle && !inMusicRoom) {
    await deleteQueueEmbed(guildId); // nothing playing, nothing queued
    return;
  }

  const existing = await findEmbedMessage(guildId);
  if (existing) {
    try {
      // attachments: [] clears the old card first — otherwise edit() keeps the previous
      // file around and a same-named new one isn't guaranteed to replace it.
      await existing.edit({ ...(await queuePayload(guildId)), attachments: [] });
      return;
    } catch (e: any) {
      // 10008 = message was deleted by someone → re-post.
      // 50035 = an old (pre-V2) panel message can't be edited into a Components V2 one →
      //         delete it and post a fresh one.
      if (e?.code !== 10008 && e?.code !== 50035) throw e;
      if (e?.code === 50035) await existing.delete().catch(() => {});
      queueMessages.delete(guildId);
    }
  }
  const ch = await getQueueChannel(guildId);
  if (!ch) return;
  trackEmbed(guildId, await ch.send(await queuePayload(guildId)));
}

/** "แสดงคิว": move the embed to the bottom of the channel (fresh message). */
async function repostQueueEmbed(guildId: string): Promise<void> {
  await deleteQueueEmbed(guildId);
  const ch = await getQueueChannel(guildId);
  if (!ch) return;
  const msg = await ch.send(await queuePayload(guildId));
  // Outside a music room, with nothing playing/queued the embed is a one-off answer, not a live one.
  if (
    setupStore.get(guildId) ||
    music.nowPlaying(guildId) ||
    music.getQueue(guildId).length > 0
  ) {
    trackEmbed(guildId, msg);
  }
}

music.onChange = (guildId) => scheduleQueueRefresh(guildId);
music.onNotFound = (guildId) => sessions.get(guildId)?.playSfx("notfound");
music.onLastSong = (guildId) => sessions.get(guildId)?.playSfx("lastsong");
music.onQueueEmpty = (guildId) => sessions.get(guildId)?.playSfx("nosong");

/**
 * Disconnect the person who said "earth เตะผม" from voice. Only ever the
 * speaker themself (the command carries their own userId). Needs the
 * Move Members permission; if missing, Discord returns 50013 and we log it.
 */
async function kickSpeaker(guildId: string, userId: string): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const vs = guild.voiceStates.cache.get(userId);
  if (!vs?.channelId) {
    console.log(`[earth-voice] kick skipped: user=${userId} is not in a voice channel`);
    return;
  }
  await guild.members.edit(userId, { channel: null, reason: "Earth voice command: เตะผม" });
  console.log(`[earth-voice] 🥾 disconnected user=${userId} from voice in guild=${guildId}`);
}

// ─── Player buttons ──────────────────────────────────────────────────────────
// The buttons under the player embed (see music/controls.ts). Like typed requests in the
// music room, they only work for people sitting in Earth's voice channel (owners always).
// Everything except 📋 is answered with deferUpdate(): the music state change fires
// music.onChange, which re-renders the embed (new card, new button states) on its own.
async function handleControlButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;
  if (!id.startsWith(CONTROL_PREFIX)) return;
  const guildId = interaction.guildId;
  if (!guildId) return;

  const session = sessions.get(guildId);
  const listening = session?.state === "listening" && !!session.channelId;
  const userVc = interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channelId ?? null;
  if (!OWNER_IDS.has(interaction.user.id) && !(listening && userVc === session!.channelId)) {
    await interaction.reply({
      content: listening
        ? `ต้องอยู่ voice channel เดียวกับเอิร์ธ (<#${session!.channelId}>) ถึงจะกดปุ่มได้ครับ`
        : "เอิร์ธยังไม่ได้อยู่ในห้องเสียงครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (id === CONTROL_ID.queue) {
    const text = buildQueueListText(music.nowPlaying(guildId), music.getQueue(guildId));
    await interaction.reply({
      components: [
        new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text)),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate(); // acknowledge within Discord's 3 s window
  const say = (content: string) =>
    interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  const userTag = `user=${interaction.user.id}`;

  try {
    switch (id) {
      case CONTROL_ID.pause:
        await music.togglePause(guildId);
        break;
      case CONTROL_ID.next: {
        const r = await music.skip(guildId);
        console.log(`[earth-voice] ⏭️ button ${userTag}: skip → ${r.skipped ? "skipped" : "nothing playing"}`);
        if (r.skipped && listening) session!.playSfx("skip");
        break;
      }
      case CONTROL_ID.previous:
        if (!(await music.previous(guildId))) await say("ยังไม่มีเพลงก่อนหน้าครับ");
        break;
      case CONTROL_ID.shuffle:
        if (!music.shuffleQueue(guildId)) await say("ต้องมีเพลงในคิวอย่างน้อย 2 เพลง ถึงจะสลับลำดับได้ครับ");
        break;
      case CONTROL_ID.loop:
        music.cycleLoop(guildId);
        break;
      case CONTROL_ID.volumeDown:
        await music.changeVolume(guildId, -VOLUME_STEP);
        break;
      case CONTROL_ID.volumeUp:
        await music.changeVolume(guildId, VOLUME_STEP);
        break;
      case CONTROL_ID.stop: {
        const wasActive = music.isPlaying(guildId) || music.getQueue(guildId).length > 0;
        await music.stop(guildId);
        console.log(`[earth-voice] ⏹️ button ${userTag}: stop`);
        if (wasActive && listening) session!.playSfx("stop");
        break;
      }
    }
  } catch (e: any) {
    console.warn(`[earth-voice] button ${id} failed:`, e?.message ?? e);
    await say(`ทำไม่สำเร็จ: ${e?.message ?? "unknown"}`);
  }
}

// ─── Slash commands ──────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    handleControlButton(interaction).catch((e: any) =>
      console.warn("[earth-voice] player button failed:", e?.message ?? e),
    );
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const cmdName = interaction.commandName;
  const isBase = YOI_BASE_NAMES.has(cmdName);
  const aliasSub = ALIAS_TO_SUBCOMMAND[cmdName];
  if (!isBase && !aliasSub) return;

  const sub = isBase ? interaction.options.getSubcommand() : aliasSub!;

  // Owner-only gate: silent ignore for anyone not in DC_OWNER_IDS
  // (no refusal message — avoids leaking the rule). Only PUBLIC_SUBCOMMANDS are open to everyone.
  const isOwner = OWNER_IDS.has(interaction.user.id);
  if (!isOwner && !PUBLIC_SUBCOMMANDS.has(sub)) {
    console.log(
      `[earth-voice] ignored /${cmdName} (${sub}) from non-owner user=${interaction.user.id} (${interaction.user.username})`,
    );
    return;
  }

  try {
    switch (sub) {
      case "help":
        await handleHelp(interaction);
        break;
      case "join":
        await handleJoin(interaction, isOwner);
        break;
      case "leave":
        await handleLeave(interaction);
        break;
      case "stop":
        await handleStop(interaction);
        break;
      case "status":
        await handleStatus(interaction);
        break;
      case "stay":
        await handleStay(interaction);
        break;
      case "unstay":
        await handleUnstay(interaction);
        break;
      case "setup":
        await handleSetup(interaction);
        break;
      case "unsetup":
        await handleUnsetup(interaction);
        break;
      default:
        await interaction.reply({
          content: `ไม่รู้จัก subcommand \`${sub}\` ครับ`,
          flags: MessageFlags.Ephemeral,
        });
    }
  } catch (e: any) {
    console.error(`[earth-voice] interaction error /earth ${sub}:`, e?.message || e);
    const errMsg = `เกิดข้อผิดพลาด: ${e?.message ?? "unknown"}`;
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errMsg, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
      }
    } catch (e2: any) {
      console.warn("[earth-voice] could not send error reply:", e2?.message ?? e2);
    }
  }
});

async function handleHelp(interaction: ChatInputCommandInteraction) {
  const helpGuildId = resolveActiveGuildId(interaction);
  const embedChannel = helpGuildId ? embedChannelId(helpGuildId) : QUEUE_CHANNEL_ID;
  const help =
    `**เอิร์ธ — ฟังเสียง + เปิดเพลง YouTube**\n` +
    `_เอิร์ธเงียบตลอด จนกว่าจะได้ยินคำสั่งเปิดเพลง_\n\n` +
    `**🎤 สั่งด้วยเสียง**\n` +
    `\`earth เปิดเพลง <ชื่อเพลง>\` — ค้นใน YouTube แล้วเล่นผลแรก (ผ่าน Lavalink + บอทเพลงอีกตัว) (สั่งใหม่ = เปลี่ยนเพลง)\n` +
    `\`earth เงียบ\` / \`earth เงียบหน่อย\` / \`earth stop\` — หยุดเพลง + ล้างคิว\n` +
    `\`earth เพิ่มเสียง\` / \`earth เบาเสียง\` — ปรับเสียงทีละ 5%\n` +
    `\`earth เพิ่มเพลง <ชื่อเพลง>\` — เพิ่มเข้าคิว (ถ้าไม่มีเพลงเล่นอยู่ = เล่นเลย)\n` +
    `\`earth ข้าม\` / \`earth skip\` — ข้ามไปเพลงถัดไปในคิว (ถ้าคิวว่าง = หยุดเพลง)\n` +
    `\`earth แสดงคิว\` — โพสต์ embed คิวใหม่ลงห้อง <#${embedChannel}>\n` +
    `\`earth ลบคิว <เลขลำดับ>\` — ลบเพลงลำดับที่ N ในคิว (1 = เพลงถัดไป)\n` +
    `\`earth เตะผม\` — ตัดคนพูดออกจากห้อง voice (บอทต้องมีสิทธิ์ Move Members)\n\n` +
    `**📋 คำสั่ง (slash)**\n` +
    `\`/earth help\` — โชว์ help นี้\n` +
    `\`/earth join [channel-id]\` — เอิร์ธเข้า voice channel\n` +
    `   • ใน guild: ไม่ต้องใส่ id (ตามคนสั่ง)  • ใน DM: ต้องใส่ \`channel-id\`\n` +
    `\`/earth leave\` — ออกจากห้อง (หยุดเพลงด้วย)\n` +
    `\`/earth stop\` — หยุดเพลง (ยังอยู่ในห้อง)\n` +
    `\`/earth status\` — ดู state, เพลงที่เล่นอยู่, STT usage\n` +
    `\`/earth stay [hours]\` — ไม่ auto-leave (สูงสุด ${STAY_MAX_HOURS} ชม.)\n` +
    `\`/earth unstay\` — กลับมา auto-leave ตามปกติ\n` +
    `\`/earth setup [channel-id]\` — ตั้งห้องเพลง: พิมพ์ชื่อเพลงในห้องนั้นได้เลย ไม่ต้องมี prefix + embed คิวอยู่ห้องนั้น\n` +
    `\`/earth unsetup\` — ยกเลิกห้องเพลง\n\n` +
    `**⚙️ ค่า auto:**\n` +
    `• ออกทันทีเมื่อในห้องไม่เหลือคนจริง ๆ (ไม่นับบอท) — ยกเว้นเปิด \`/earth stay\`\n` +
    `• auto-leave ถ้าอยู่คนเดียวเกิน ${Math.floor(AUTO_LEAVE_ALONE_MS / 60000)} นาที (ไม่ออกเพราะเงียบ — เงียบนานแค่ไหนก็อยู่ต่อ)\n`;

  await interaction.reply({ content: help, flags: MessageFlags.Ephemeral });
}

/** Connect the listener bot to `voiceChannel` (shared by /earth join and the music room). */
async function connectSession(
  session: VoiceSession,
  voiceChannel: VoiceBasedChannel,
  guildId: string,
): Promise<void> {
  await session.connect({
    channelId: voiceChannel.id,
    guildId,
    channelName: voiceChannel.name,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    silenceThresholdMs: SILENCE_THRESHOLD_MS,
    listenUserIds: LISTEN_USER_IDS,
    onSpeech: (ev) => {
      handleSpeech(session, ev).catch((e: any) =>
        console.warn("[earth-voice] handleSpeech failed:", e?.message ?? e),
      );
    },
    onConnectionLost: () => {
      autoLeave(session, "voice connection lost (kicked / channel deleted)").catch((e) =>
        console.warn("[earth-voice] auto-leave after connection loss failed:", e),
      );
    },
  });
  checkAloneNow(guildId);
}

async function handleJoin(interaction: ChatInputCommandInteraction, isOwner: boolean) {
  const explicitChannelId = interaction.options.getString("channel-id");
  let voiceChannel: VoiceBasedChannel | null = null;
  let guildId: string | null = null;

  // Non-owners: only "join the voice channel I am in", inside a server the bot is in.
  // A channel-id (or a DM) would let anyone pull Earth into a channel they can't even see.
  if (!isOwner) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "ใช้ได้เฉพาะในเซิร์ฟเวอร์ครับ — เข้า voice channel แล้วพิมพ์ `/earth join`",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (explicitChannelId) {
      await interaction.reply({
        content: "เข้า voice channel ที่ต้องการแล้วพิมพ์ `/earth join` เฉยๆ ครับ (ไม่ต้องใส่ channel-id)",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (explicitChannelId) {
    // DM path, or a guild user overriding their current voice channel
    try {
      const ch = await client.channels.fetch(explicitChannelId);
      if (!ch || !ch.isVoiceBased() || !("guildId" in ch) || !ch.guildId) {
        await interaction.reply({
          content: `\`${explicitChannelId}\` ไม่ใช่ voice channel ครับ`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      voiceChannel = ch as VoiceBasedChannel;
      guildId = ch.guildId;
    } catch (e: any) {
      await interaction.reply({
        content: `fetch channel ล้มเหลว: ${e?.message ?? e}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else if (interaction.guildId) {
    guildId = interaction.guildId;
    const member = interaction.member as GuildMember | null;
    voiceChannel = member?.voice.channel ?? null;
    if (!voiceChannel) {
      await interaction.reply({
        content: "ต้องอยู่ใน voice channel ก่อนครับ`",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else {
    await interaction.reply({
      content:
        "ใน DM ต้องใส่ `channel-id` ครับ — เช่น `/earth join channel-id:123456789012345678`",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionFor(guildId);
  if (session.state !== "idle") {
    await interaction.reply({
      content: `เอิร์ธอยู่ใน **${session.channelName}** อยู่แล้วครับ (state: ${session.state})\nใช้ \`/earth leave\` ก่อนถ้าจะย้าย`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await connectSession(session, voiceChannel, guildId);
  await interaction.editReply(
    `เอิร์ธเข้า **${voiceChannel.name}** แล้วครับ\n` +
      `_(auto-leave ถ้าคนเดียวเกิน ${Math.floor(AUTO_LEAVE_ALONE_MS / 60000)} นาที)_`,
  );
  console.log(
    `[earth-voice] joined channel=${voiceChannel.id} (${voiceChannel.name}) in guild=${guildId} via=${interaction.guildId ? "guild" : "DM"}`,
  );
}

async function replyNoGuild(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    content:
      "หาไม่เจอว่า guild ไหนครับ — ยังไม่มี active session + ไม่ได้ตั้ง DISCORD_GUILD_ID",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLeave(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);

  if (!session || session.state === "idle") {
    await interaction.reply({
      content: "เอิร์ธไม่ได้อยู่ใน voice channel ครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (session.state !== "listening") {
    await interaction.reply({
      content: `session อยู่ในสถานะ ${session.state} — ลองใหม่อีกสักครู่ครับ`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const usageReport = session.getUsageReport();
  const { chunks, durationMs, channelName } = await endSession(session);
  const duration = formatDuration(durationMs);

  await interaction.reply({
    content:
      `เอิร์ธออกจาก **${channelName ?? "voice channel"}** แล้วครับ\n` +
      `- Duration: ${duration}\n- Chunks: ${chunks}\n\n` +
      `**📊 STT usage (this session):**\n\`\`\`\n${usageReport}\n\`\`\``,
    flags: MessageFlags.Ephemeral,
  });
  console.log(
    `[earth-voice] left guild=${guildId} channel=${channelName} after ${duration}, ${chunks} chunks`,
  );
}

async function handleStop(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);
  if (!session || session.state !== "listening") {
    await interaction.reply({
      content: "เอิร์ธไม่ได้อยู่ใน voice channel ครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const was = music.nowPlaying(guildId);
  await music.stop(guildId);
  if (was) session.playSfx("stop");
  await interaction.reply({
    content: was ? `หยุดเพลง **${was.title}** แล้วครับ` : "ตอนนี้ไม่ได้เล่นเพลงอยู่ครับ",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);
  const status = session?.getStatus();

  if (!session || !status || status.state === "idle") {
    await interaction.reply({
      content: "**สถานะเอิร์ธ**\n- ยังไม่ join voice channel ครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const duration = status.startedAt ? formatDuration(Date.now() - status.startedAt) : "0s";
  const np = music.nowPlaying(guildId);

  await interaction.reply({
    content:
      `**สถานะเอิร์ธ**\n` +
      `- State: ${status.state}\n` +
      `- Channel: **${status.channelName}** (id=${status.channelId})\n` +
      `- Duration: ${duration}\n` +
      `- Chunks: ${status.chunkCount}\n` +
      `- Now playing: ${np ? `${np.title}${np.uri ? ` (${np.uri})` : ""}` : "—"}\n` +
      `- Queue: ${music.getQueue(guildId).length} เพลง\n` +
      `\`\`\`\n${session.getUsageReport()}\n\`\`\``,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStay(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);
  if (!session || session.state !== "listening") {
    await interaction.reply({
      content: "ต้อง `/earth join` ก่อนถึงจะ `/earth stay` ได้ครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const requested = interaction.options.getNumber("hours") ?? STAY_MAX_HOURS;
  const hours = Math.min(Math.max(requested, 0.1), STAY_MAX_HOURS);
  const ms = Math.floor(hours * 3_600_000);
  session.setPersistent(ms);
  const until = new Date(Date.now() + ms);
  const hh = String(until.getHours()).padStart(2, "0");
  const mm = String(until.getMinutes()).padStart(2, "0");
  await interaction.reply({
    content:
      `stay ON ใน **${session.channelName}** — ${hours} ชม. (อยู่จนถึง ~${hh}:${mm})\n` +
      `_auto-leave-alone ถูกข้าม จนกว่าจะหมดเวลาหรือ \`/earth unstay\`_`,
    flags: MessageFlags.Ephemeral,
  });
  console.log(`[earth-voice] stay ON guild=${guildId} for ${hours}h (until ${until.toISOString()})`);
}

async function handleUnstay(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const session = sessions.get(guildId);
  if (!session || session.state === "idle") {
    await interaction.reply({
      content: "ไม่ได้อยู่ใน voice channel ครับ",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const was = session.isPersistent();
  session.clearPersistent();
  checkAloneNow(guildId); // channel already empty? leave now
  await interaction.reply({
    content: was
      ? `stay OFF — auto-leave watchers กลับมาทำงานปกติแล้วนะครับ`
      : `ตอนนี้ไม่ได้อยู่ใน stay mode อยู่แล้วครับ`,
    flags: MessageFlags.Ephemeral,
  });
  console.log(`[earth-voice] stay OFF guild=${guildId} (was=${was})`);
}

// ─── Music room: /earth setup ────────────────────────────────────────────────
async function handleSetup(interaction: ChatInputCommandInteraction) {
  const channelId = interaction.options.getString("channel-id")?.trim() || interaction.channelId;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || ch.isDMBased() || !ch.isTextBased()) {
    await interaction.reply({
      content: `\`${channelId}\` ไม่ใช่ text channel ใน server ครับ (ใน DM ต้องใส่ \`channel-id\` ของห้องข้อความ)`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The listener bot posts/edits the embed and reads the typed requests → check it can.
  const me = ch.guild.members.me ?? (await ch.guild.members.fetchMe().catch(() => null));
  const perms = me ? ch.permissionsFor(me) : null;
  const missing = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ].filter((flag) => !perms?.has(flag));
  if (missing.length > 0) {
    await interaction.reply({
      content:
        `บอทฟังยังขาดสิทธิ์ใน <#${ch.id}> ครับ: ${new PermissionsBitField(missing).toArray().join(", ")}\n` +
        `เพิ่มสิทธิ์แล้วลอง \`/earth setup\` ใหม่`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const canDelete = perms?.has(PermissionFlagsBits.ManageMessages) ?? false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = ch.guildId;
  await runQueueUi(guildId, async () => {
    await deleteQueueEmbed(guildId); // the old room's embed (if the room moved)
    setupStore.set(guildId, { channelId: ch.id });
    await refreshQueueEmbed(guildId); // post the panel in the new room
  });
  const posted = queueMessages.has(guildId);

  let reply =
    `✅ ตั้งห้องเพลงเป็น <#${ch.id}> แล้วครับ\n` +
    `• พิมพ์ชื่อเพลงในห้องนั้นได้เลย (ไม่ต้องมี prefix) — ต้องอยู่ voice channel เดียวกับเอิร์ธ\n` +
    `• embed คิว/เพลงที่เล่นอยู่ (รวมถึงตอนสั่งด้วยเสียง) จะอยู่ในห้องนั้นที่เดียว`;
  if (SETUP_DELETE_MESSAGES && !canDelete) {
    reply +=
      `\n⚠️ บอทไม่มีสิทธิ์ Manage Messages — ข้อความที่พิมพ์ขอเพลงจะไม่ถูกลบ ` +
      `(embed จะค่อย ๆ เลื่อนขึ้น ใช้ \`earth แสดงคิว\` ดึงกลับลงมาได้)`;
  }
  if (!posted) reply += `\n⚠️ ส่ง embed ลงห้องไม่สำเร็จ — ดู log ของบอท`;
  await interaction.editReply(reply);
  console.log(`[earth-voice] setup: guild=${guildId} music room=${ch.id}`);
}

async function handleUnsetup(interaction: ChatInputCommandInteraction) {
  const guildId = resolveActiveGuildId(interaction);
  if (!guildId) return replyNoGuild(interaction);
  const entry = setupStore.get(guildId);
  if (!entry) {
    await interaction.reply({
      content: "ยังไม่ได้ตั้งห้องเพลงครับ (ใช้ `/earth setup`)",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await runQueueUi(guildId, async () => {
    await deleteQueueEmbed(guildId);
    setupStore.delete(guildId);
    await refreshQueueEmbed(guildId); // back to the normal embed channel (only if something is playing)
  });
  await interaction.editReply(`ยกเลิกห้องเพลง <#${entry.channelId}> แล้วครับ`);
  console.log(`[earth-voice] unsetup: guild=${guildId} (was ${entry.channelId})`);
}

// Typed song requests in the music room: the whole message is the song name.
client.on(Events.MessageCreate, (message) => {
  handleSetupMessage(message).catch((e: any) =>
    console.warn("[earth-voice] music-room message failed:", e?.message ?? e),
  );
});

async function handleSetupMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.inGuild()) return;
  const guildId = message.guildId;
  if (setupStore.get(guildId)?.channelId !== message.channelId) return;

  const query = parseSongRequest(message.content);
  if (!query) return;

  // One request at a time per server: two people typing together must not both see
  // "nothing is playing" and fight over the same slot.
  await serial(setupChains, guildId, "music-room request failed", () =>
    processSetupRequest(message, guildId, query),
  );
}

async function processSetupRequest(message: Message<true>, guildId: string, query: string) {
  const reject = async (text: string) => {
    await tempReply(message, text);
    await removeRequest(message);
  };

  const voiceChannel = message.member?.voice.channel ?? null;
  if (!voiceChannel) return reject("เข้า voice channel ก่อนนะครับ แล้วพิมพ์ชื่อเพลงใหม่");

  const session = sessionFor(guildId);
  const inRoom = session.state === "listening" && !!session.channelId;
  if (inRoom) {
    if (voiceChannel.id !== session.channelId) {
      return reject(`ต้องอยู่ voice channel เดียวกับเอิร์ธ (<#${session.channelId}>) ครับ`);
    }
  } else {
    // Earth isn't in any room yet: only owners may call it in (same rule as /earth join).
    if (!OWNER_IDS.has(message.author.id)) {
      return reject("เอิร์ธยังไม่ได้เข้าห้องเสียง — ให้เจ้าของเรียกเอิร์ธเข้าห้องก่อนนะครับ");
    }
    if (session.state !== "idle") {
      return reject("เอิร์ธกำลังเชื่อมต่อห้องเสียงอยู่ ลองใหม่อีกครั้งในสักครู่ครับ");
    }
    try {
      await connectSession(session, voiceChannel, guildId);
    } catch (e: any) {
      console.warn("[earth-voice] music room: could not join voice:", e?.message ?? e);
      return reject(`เข้าห้องเสียงไม่ได้: ${e?.message ?? "unknown"}`);
    }
  }

  console.log(
    `[earth-voice] 💬 music room request from user=${message.author.id}: "${query}"`,
  );
  let result: Awaited<ReturnType<typeof music.enqueue>>;
  try {
    // nothing playing → plays now; otherwise it goes to the end of the queue
    result = await music.enqueue(guildId, voiceChannel.id, query, message.author.id);
  } catch (e: any) {
    console.warn(`[earth-voice] music room enqueue failed for "${query}":`, e?.message ?? e);
    return reject(`เล่นไม่ได้: ${e?.message ?? "unknown"}`);
  }
  // null = not found / queue full; music.onNotFound already played the "not found" sound.
  if (!result) {
    const shown = query.length > 60 ? `${query.slice(0, 59)}…` : query;
    return reject(`หาเพลง "${shown}" ไม่เจอ หรือคิวเต็มครับ`);
  }
  session.playSfx(result.position === 0 ? "play" : "add");
  if (result.playlist) {
    const pl = result.playlist;
    const name = pl.name ? ` "${pl.name.length > 40 ? `${pl.name.slice(0, 39)}…` : pl.name}"` : "";
    let text = `เพิ่มเพลย์ลิสต์${name} ${pl.added} เพลงแล้วครับ`;
    if (pl.dropped > 0) text += ` (คิวเต็ม เหลืออีก ${pl.dropped} เพลงที่ไม่ได้เพิ่ม)`;
    if (pl.skipped > 0) text += ` (ข้าม ${pl.skipped} คลิปที่เล่นไม่ได้หรือยาวเกินกำหนด)`;
    await tempReply(message, text);
  }
  await removeRequest(message);
}

/** Short-lived reply in the music room (the request message is removed, so mention the author). */
async function tempReply(message: Message, text: string, ms = 8000): Promise<void> {
  if (!message.channel.isSendable()) return;
  const sent = await message.channel
    .send({
      content: `<@${message.author.id}> ${text}`,
      allowedMentions: { users: [message.author.id] },
    })
    .catch(() => null);
  if (sent) setTimeout(() => void sent.delete().catch(() => {}), ms);
}

async function removeRequest(message: Message): Promise<void> {
  if (SETUP_DELETE_MESSAGES) await message.delete().catch(() => {});
}

// If the music room is deleted, forget it (the embed falls back to QUEUE_CHANNEL_ID).
client.on(Events.ChannelDelete, (channel) => {
  const gid = setupStore.guildForChannel(channel.id);
  if (!gid) return;
  console.log(`[earth-voice] music room ${channel.id} was deleted — setup removed for guild=${gid}`);
  queueMessages.delete(gid);
  setupStore.delete(gid);
});

/** Leave the voice channel with BOTH bots (listener + music). */
async function endSession(session: VoiceSession) {
  const gid = session.guildId;
  if (gid) {
    const t = aloneTimers.get(gid);
    if (t) clearTimeout(t);
    aloneTimers.delete(gid);
    aloneSince.delete(gid);
  }
  if (gid) await music.leave(gid);
  return session.disconnect();
}

// === Instant leave when no human is left in the channel ===
const aloneTimers = new Map<string, ReturnType<typeof setTimeout>>(); // guildId → pending leave

function humansInChannel(guildId: string, channelId: string): number {
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) return -1;
  return (channel as VoiceBasedChannel).members.filter((m) => !m.user.bot).size;
}

function checkAloneNow(guildId: string): void {
  const session = sessions.get(guildId);
  const pending = aloneTimers.get(guildId);

  const cancel = () => {
    if (pending) {
      clearTimeout(pending);
      aloneTimers.delete(guildId);
    }
  };

  if (!session || session.state !== "listening" || !session.channelId) return cancel();
  const humans = humansInChannel(guildId, session.channelId);
  // Someone is (back) in the channel, or channel unknown → don't leave.
  if (humans !== 0) return cancel();
  // /earth stay keeps Earth in the room even when empty.
  if (session.isPersistent()) return cancel();
  if (pending) return; // countdown already running

  aloneTimers.set(
    guildId,
    setTimeout(() => {
      aloneTimers.delete(guildId);
      const s = sessions.get(guildId);
      if (!s || s.state !== "listening" || !s.channelId) return;
      // Re-check: someone may have joined during the grace period.
      if (humansInChannel(guildId, s.channelId) !== 0 || s.isPersistent()) return;
      autoLeave(s, "no humans left in voice channel").catch((e) =>
        console.warn("[earth-voice] auto-leave (no humans) failed:", e),
      );
    }, Math.max(0, ALONE_LEAVE_DELAY_MS)),
  );
}

client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
  // A human left / switched channel, or the bot itself was moved.
  const gid = oldState.guild.id;
  if (!sessions.has(gid)) return;
  checkAloneNow(gid);
});

// === Auto-leave (alone / stay expiry / connection lost) ===
async function autoLeave(session: VoiceSession, reason: string): Promise<void> {
  if (session.state !== "listening") return;
  console.log(`[earth-voice] auto-leaving ${session.channelName} (${reason})`);
  const { channelName, durationMs } = await endSession(session);
  console.log(`[earth-voice] auto-left ${channelName} after ${formatDuration(durationMs)}`);
}

function startAutoLeaveWatcher() {
  if (AUTO_LEAVE_ALONE_MS <= 0) {
    console.log("[earth-voice] auto-leave-when-alone disabled");
    return;
  }
  setInterval(async () => {
    for (const [guildId, session] of sessions) {
      if (session.state !== "listening" || !session.channelId) continue;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const channel = guild.channels.cache.get(session.channelId);
      if (!channel || !channel.isVoiceBased()) continue;
      const vc = channel as VoiceBasedChannel;
      const humans = vc.members.filter((m) => !m.user.bot);
      if (humans.size === 0) {
        // /earth stay overrides alone auto-leave.
        if (session.isPersistent()) {
          aloneSince.delete(guildId);
          continue;
        }
        if (!aloneSince.has(guildId)) {
          aloneSince.set(guildId, Date.now());
          console.log(
            `[earth-voice] alone in ${session.channelName} (guild ${guildId}) — countdown started`,
          );
        } else if (Date.now() - aloneSince.get(guildId)! > AUTO_LEAVE_ALONE_MS) {
          aloneSince.delete(guildId);
          await autoLeave(session, `alone > ${AUTO_LEAVE_ALONE_MS}ms`).catch((e) =>
            console.warn("[earth-voice] auto-leave (alone) failed:", e),
          );
        }
      } else {
        aloneSince.delete(guildId);
      }
    }
  }, 30_000);
}

// Even with /earth stay, hard-leave when the persistent window expires.
function startPersistentCapWatcher() {
  setInterval(async () => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.state !== "listening") continue;
      const until = session.getPersistentUntil();
      if (until > 0 && now >= until) {
        session.clearPersistent();
        const hours = Math.floor((now - (session.startedAt ?? now)) / 3_600_000);
        await autoLeave(session, `stay expired (~${hours}h cap)`).catch((e) =>
          console.warn("[earth-voice] auto-leave (stay expiry) failed:", e),
        );
      }
    }
  }, 60_000);
}

// The card is a still picture, so its elapsed / total time only moves when the panel is
// re-rendered. While a song is playing, refresh the panel every CARD_TICK_MS so the time
// and bar follow the real position. Paused / streams / no panel → nothing to update.
const CARD_TICK_MS = 10_000;
function startCardTicker() {
  setInterval(() => {
    for (const gid of client.guilds.cache.keys()) {
      const np = music.nowPlaying(gid);
      if (!np || np.isStream || !(np.lengthMs > 0) || music.isPaused(gid)) continue;
      if (!queueMessages.has(gid)) continue; // don't re-create a panel someone deleted
      scheduleQueueRefresh(gid);
    }
  }, CARD_TICK_MS);
}

function startMemoryReporter() {
  if (MEMORY_REPORT_MS <= 0) {
    console.log("[earth-voice] memory reporter disabled");
    return;
  }
  setInterval(() => {
    const m = process.memoryUsage();
    const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;
    console.log(
      `[earth-voice] mem rss=${fmt(m.rss)} heap=${fmt(m.heapUsed)}/${fmt(m.heapTotal)} ext=${fmt(m.external)}`,
    );
  }, MEMORY_REPORT_MS);
}

client.on(Events.Error, (e) => {
  console.error("[earth-voice] client error:", e);
});

process.on("unhandledRejection", (e) => {
  console.error("[earth-voice] unhandled rejection:", e);
});
process.on("uncaughtException", (e) => {
  console.error("[earth-voice] uncaught exception:", e);
});

// Graceful shutdown: leave every channel (stops music on both bots).
let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[earth-voice] received ${sig}, disconnecting all sessions...`);
    for (const [gid, s] of sessions) {
      if (s.state === "idle") continue;
      try {
        await endSession(s);
        console.log(`[earth-voice] disconnected guild=${gid}`);
      } catch (e) {
        console.warn(`[earth-voice] disconnect failed for guild=${gid}:`, e);
      }
    }
    for (const gid of [...queueMessages.keys()]) {
      // A music room keeps its panel (flipped to idle); the normal embed is deleted.
      if (setupStore.get(gid)) await refreshQueueEmbed(gid).catch(() => {});
      else await deleteQueueEmbed(gid);
    }
    music.client.destroy();
    client.destroy();
    process.exit(0);
  });
}

console.log(`[earth-voice] starting... STT=${sttSummary()}`);
await loadSfx();
await music.start(musicToken);
await client.login(token);
