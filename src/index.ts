#!/usr/bin/env bun
/**
 * Earth Voice Bot — STT + YouTube music
 *
 * Joins a Discord voice channel and listens (Groq Whisper). Earth is silent
 * unless someone says:
 *
 *     "earth/jarvis เปิดเพลง <ชื่อเพลง>"   (or "earth/jarvis เงียบ" / "earth/jarvis เงียบหน่อย" to stop)
 *
 * in which case a SECOND bot (MUSIC_BOT_TOKEN) joins the same channel and plays
 * the top YouTube result through Lavalink. (One bot can hold only one voice
 * connection per guild, so listening and playing use separate accounts.)
 * Nothing that is said is saved or posted anywhere.
 *
 * Slash commands (owner-only, see DC_OWNER_IDS):
 *   /earth join [channel-id]  — join the caller's voice channel
 *   /earth leave              — leave (stops music)
 *   /earth stop               — stop the current song
 *   /earth status             — session state, now playing, STT usage
 *   /earth stay [hours]       — disable auto-leave for a while (max 24h)
 *   /earth unstay             — re-enable auto-leave
 *
 * Earth only listens to LISTEN_USER_IDS (default: one specific user); voice
 * commands come only from them. Voice: "earth/jarvis เพิ่มเสียง" / "earth/jarvis เบาเสียง" = ±5%.
 * Voice: "earth/jarvis เตะผม" / "earth/jarvis ออก" = disconnect the speaker from the voice channel
 * (needs the Move Members permission for the listener bot).
 *
 * Queue (all by voice):
 *   "earth/jarvis เพิ่มเพลง <ชื่อเพลง>"  — add to queue (plays now if nothing is playing)
 *   "earth/jarvis ข้าม" / "earth/jarvis skip" — skip to the next song (stops if queue is empty)
 *   "earth/jarvis ลบคิว <เลขลำดับ>"       — remove item #N from the queue (1 = next up)
 *   "earth/jarvis แสดงคิว"               — re-post the queue embed at the bottom of the channel
 * A live queue embed lives in QUEUE_CHANNEL_ID (text channel): it is created when a song
 * starts, edited whenever the queue / current song changes, and deleted when playback
 * ends. "เงียบ" (or "stop") stops the song, clears the queue and deletes the embed.
 *
 * Auto-leave: as soon as no human is left in the channel, Earth leaves
 * (after a short grace, ALONE_LEAVE_DELAY_MS) — unless /earth stay is on.
 *
 * Run:
 *   bun src/index.ts          (foreground)
 *   bun --watch src/index.ts  (dev)
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
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
import { LavalinkMusic } from "./music/lavalink.ts";
import { loadSfx } from "./sfx.ts";
import { buildQueueEmbed } from "./music/queue.ts";

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
if (!process.env.GROQ_API_KEY) {
  console.error("[earth-voice] GROQ_API_KEY missing in .env (get one at https://console.groq.com)");
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
    "[earth-voice] ⚠️ DC_OWNER_IDS is empty — slash commands will be ignored for ALL users",
  );
}

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
  // Server Members / Message Content intents are no longer needed.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

const music = new LavalinkMusic();
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
      .enqueue(session.guildId, session.channelId, cmd.query)
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
    .play(session.guildId, session.channelId, cmd.query)
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

/** Run embed work for a guild strictly one at a time (so we never post two embeds). */
function runQueueUi(guildId: string, fn: () => Promise<void>): void {
  const prev = queueUiChains.get(guildId) ?? Promise.resolve();
  const next = prev.then(fn).catch((e: any) => {
    console.warn("[earth-voice] queue embed update failed:", e?.message ?? e);
  });
  queueUiChains.set(guildId, next);
}

/** Coalesce bursts of changes (play + advance + ...) into one embed update. */
function scheduleQueueRefresh(guildId: string): void {
  if (queueRefreshTimers.has(guildId)) return;
  queueRefreshTimers.set(
    guildId,
    setTimeout(() => {
      queueRefreshTimers.delete(guildId);
      runQueueUi(guildId, () => refreshQueueEmbed(guildId));
    }, 250),
  );
}

async function getQueueChannel() {
  const ch = await client.channels.fetch(QUEUE_CHANNEL_ID).catch((e: any) => {
    console.warn(`[earth-voice] cannot fetch queue channel ${QUEUE_CHANNEL_ID}:`, e?.message ?? e);
    return null;
  });
  if (!ch || !ch.isSendable()) {
    console.warn(`[earth-voice] queue channel ${QUEUE_CHANNEL_ID} is missing or not a text channel`);
    return null;
  }
  return ch;
}

async function deleteQueueEmbed(guildId: string): Promise<void> {
  const msg = queueMessages.get(guildId);
  queueMessages.delete(guildId);
  if (!msg) return;
  await msg.delete().catch(() => {}); // already gone / no permission → nothing to do
}

function queuePayload(guildId: string) {
  return {
    embeds: [buildQueueEmbed(music.nowPlaying(guildId), music.getQueue(guildId))],
    allowedMentions: { parse: [] as never[] },
  };
}

/** Make the embed match the current music state: create / edit / delete. */
async function refreshQueueEmbed(guildId: string): Promise<void> {
  const now = music.nowPlaying(guildId);
  if (!now && music.getQueue(guildId).length === 0) {
    await deleteQueueEmbed(guildId); // nothing playing, nothing queued
    return;
  }

  const existing = queueMessages.get(guildId);
  if (existing) {
    try {
      await existing.edit(queuePayload(guildId));
      return;
    } catch (e: any) {
      if (e?.code !== 10008) throw e; // 10008 = message was deleted by someone → re-post
      queueMessages.delete(guildId);
    }
  }
  const ch = await getQueueChannel();
  if (!ch) return;
  queueMessages.set(guildId, await ch.send(queuePayload(guildId)));
}

/** "แสดงคิว": move the embed to the bottom of the channel (fresh message). */
async function repostQueueEmbed(guildId: string): Promise<void> {
  await deleteQueueEmbed(guildId);
  const ch = await getQueueChannel();
  if (!ch) return;
  const msg = await ch.send(queuePayload(guildId));
  // With nothing playing/queued the embed is a one-off answer, not a live one.
  if (music.nowPlaying(guildId) || music.getQueue(guildId).length > 0) {
    queueMessages.set(guildId, msg);
  }
}

music.onChange = (guildId) => scheduleQueueRefresh(guildId);
music.onNotFound = (guildId) => sessions.get(guildId)?.playSfx("notfound");

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
  await guild.members.edit(userId, { channel: null, reason: "Earth voice command: เตะผม / ออก" });
  console.log(`[earth-voice] 🥾 disconnected user=${userId} from voice in guild=${guildId}`);
}

// ─── Slash commands ──────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmdName = interaction.commandName;
  const isBase = YOI_BASE_NAMES.has(cmdName);
  const aliasSub = ALIAS_TO_SUBCOMMAND[cmdName];
  if (!isBase && !aliasSub) return;

  // Owner-only gate: silent ignore for anyone not in DC_OWNER_IDS
  // (no refusal message — avoids leaking the rule).
  if (!OWNER_IDS.has(interaction.user.id)) {
    console.log(
      `[earth-voice] ignored /${cmdName} from non-owner user=${interaction.user.id} (${interaction.user.username})`,
    );
    return;
  }

  const sub = isBase ? interaction.options.getSubcommand() : aliasSub!;

  try {
    switch (sub) {
      case "help":
        await handleHelp(interaction);
        break;
      case "join":
        await handleJoin(interaction);
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
  const help =
    `**เอิร์ธ — ฟังเสียง + เปิดเพลง YouTube**\n` +
    `_เอิร์ธเงียบตลอด จนกว่าจะได้ยินคำสั่งเปิดเพลง_\n\n` +
    `**🎤 สั่งด้วยเสียง**\n` +
    `\`earth/jarvis เปิดเพลง <ชื่อเพลง>\` — ค้นใน YouTube แล้วเล่นผลแรก (ผ่าน Lavalink + บอทเพลงอีกตัว) (สั่งใหม่ = เปลี่ยนเพลง)\n` +
    `\`earth/jarvis เงียบ\` / \`earth/jarvis เงียบหน่อย\` / \`earth/jarvis stop\` — หยุดเพลง + ล้างคิว\n` +
    `\`earth/jarvis เพิ่มเสียง\` / \`earth/jarvis เบาเสียง\` — ปรับเสียงทีละ 5%\n` +
    `\`earth/jarvis เพิ่มเพลง <ชื่อเพลง>\` — เพิ่มเข้าคิว (ถ้าไม่มีเพลงเล่นอยู่ = เล่นเลย)\n` +
    `\`earth/jarvis ข้าม\` / \`earth/jarvis skip\` — ข้ามไปเพลงถัดไปในคิว (ถ้าคิวว่าง = หยุดเพลง)\n` +
    `\`earth/jarvis แสดงคิว\` — โพสต์ embed คิวใหม่ลงห้อง <#${QUEUE_CHANNEL_ID}>\n` +
    `\`earth/jarvis ลบคิว <เลขลำดับ>\` — ลบเพลงลำดับที่ N ในคิว (1 = เพลงถัดไป)\n` +
    `\`earth/jarvis เตะผม\` — ตัดคนพูดออกจากห้อง voice (บอทต้องมีสิทธิ์ Move Members)\n\n` +
    `**📋 คำสั่ง (slash)**\n` +
    `\`/earth help\` — โชว์ help นี้\n` +
    `\`/earth join [channel-id]\` — เอิร์ธเข้า voice channel\n` +
    `   • ใน guild: ไม่ต้องใส่ id (ตามคนสั่ง)  • ใน DM: ต้องใส่ \`channel-id\`\n` +
    `\`/earth leave\` — ออกจากห้อง (หยุดเพลงด้วย)\n` +
    `\`/earth stop\` — หยุดเพลง (ยังอยู่ในห้อง)\n` +
    `\`/earth status\` — ดู state, เพลงที่เล่นอยู่, STT usage\n` +
    `\`/earth stay [hours]\` — ไม่ auto-leave (สูงสุด ${STAY_MAX_HOURS} ชม.)\n` +
    `\`/earth unstay\` — กลับมา auto-leave ตามปกติ\n\n` +
    `**⚙️ ค่า auto:**\n` +
    `• ออกทันทีเมื่อในห้องไม่เหลือคนจริง ๆ (ไม่นับบอท) — ยกเว้นเปิด \`/earth stay\`\n` +
    `• auto-leave ถ้าอยู่คนเดียวเกิน ${Math.floor(AUTO_LEAVE_ALONE_MS / 60000)} นาที (ไม่ออกเพราะเงียบ — เงียบนานแค่ไหนก็อยู่ต่อ)\n`;

  await interaction.reply({ content: help, flags: MessageFlags.Ephemeral });
}

async function handleJoin(interaction: ChatInputCommandInteraction) {
  const explicitChannelId = interaction.options.getString("channel-id");
  let voiceChannel: VoiceBasedChannel | null = null;
  let guildId: string | null = null;

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
    for (const gid of [...queueMessages.keys()]) await deleteQueueEmbed(gid);
    music.client.destroy();
    client.destroy();
    process.exit(0);
  });
}

console.log(
  `[earth-voice] starting... STT=groq (${process.env.GROQ_STT_MODEL || "whisper-large-v3"}, lang=${process.env.GROQ_STT_LANGUAGE || "th"})`,
);
await loadSfx();
await music.start(musicToken);
await client.login(token);
