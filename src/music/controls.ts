/**
 * The button rows under the player embed (Discord Message Components), laid out like the
 * reference screenshot — all grey, 5 per row:
 *
 *   row 1:  🔀 shuffle   ⏮ previous   ⏸/▶ pause·resume   ⏭ next   🔁 loop
 *   row 2:  📋 queue     🔉 vol −      ⏹ stop              🔊 vol +    (blank, disabled)
 *
 * Only the ids and the look live here; what each button does is handled in index.ts
 * (handleControlButton), which switches on these ids.
 *
 * Queue dropdown (also Components V2, see the bottom of this file):
 *
 *   📋 [ Dropdown: the songs waiting in the queue ▾ ]     ← sits right above the button rows
 *        │ pick a song
 *        ▼
 *   ephemeral panel:  ### 🎵 เพลงในคิว #3
 *                     **Title** …                         (+ thumbnail)
 *                     [ ▶ เล่นเลย ]  [ 🗑 ลบออกจากคิว ]
 *
 * index.ts handles it in handleQueueSelect / handleQueueButton.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import { clip, escapeMd, fmtMs, thumbnailFor, type LoopMode, type QueueTrack } from "./queue.ts";

/** customId prefix — every button of the player starts with it. */
export const CONTROL_PREFIX = "mc:";

export const CONTROL_ID = {
  shuffle: "mc:shuffle",
  previous: "mc:previous",
  pause: "mc:pause",
  next: "mc:next",
  loop: "mc:loop",
  queue: "mc:queue",
  volumeDown: "mc:voldown",
  stop: "mc:stop",
  volumeUp: "mc:volup",
} as const;

/** Volume change per click, in percent (same step as the "เพิ่มเสียง / เบาเสียง" voice commands). */
export const VOLUME_STEP = 5;

export interface ControlState {
  paused: boolean;
  loop: LoopMode;
  /** Nothing is playing: show every button, but greyed out and unclickable. */
  disabled?: boolean;
}

const LOOP_EMOJI: Record<LoopMode, string> = { none: "<:Gemini_Generated_Image_hznznshzn:1569242460553482300>", track: "<:Gemini_Generated_Image_fwokl8fwo:1569246833492889651>", queue: "<:Gemini_Generated_Image_1bzb411bz:1569246870465810482>" };

/** Disabled filler so the second row is 5 wide like the first (never clickable, so no handler). */
const BLANK_ID = "mc:blank";

/** Every button is grey (Secondary); loop's on/off state shows in its emoji and the panel text. */
export function buildControlRows({
  paused,
  loop,
  disabled = false,
}: ControlState): ActionRowBuilder<ButtonBuilder>[] {
  const btn = (id: string, emoji: string) =>
    new ButtonBuilder()
      .setCustomId(id)
      .setEmoji(emoji)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    btn(CONTROL_ID.shuffle, "<:Gemini_Generated_Image_nfqiienfq:1569244336980492308>"),
    btn(CONTROL_ID.previous, "<:Gemini_Generated_Image_402sjg402:1569243289964519494>"),
    btn(CONTROL_ID.pause, paused ? "<:5134resume:1569242000203456584>" : "<:6148pause:1569241101905432617>"),
    btn(CONTROL_ID.next, "<:4303discordcategorycollapsedwhit:1569242059251130389>"),
    btn(CONTROL_ID.loop, LOOP_EMOJI[loop]),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    btn(CONTROL_ID.queue, "<:1731discordprofileactivitywhite:1569242674307797042>"),
    btn(CONTROL_ID.volumeDown, "🔉"),
    btn(CONTROL_ID.stop, "<:Gemini_Generated_Image_pj02gnpj0:1569243957844508672>"),
    btn(CONTROL_ID.volumeUp, "🔊"),
    new ButtonBuilder()
      .setCustomId(BLANK_ID)
      .setLabel("\u200b") // zero-width space: Discord needs a label or an emoji on every button
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
  return [row1, row2];
}

// ─── Queue dropdown ──────────────────────────────────────────────────────────

/** customId prefix of the queue dropdown and of the ▶ / 🗑 buttons under a picked song. */
export const QUEUE_PREFIX = "mq:";

export const QUEUE_ID = {
  /** The dropdown itself (its value is a song id, see `queueItemId`). */
  select: "mq:pick",
  /** "mq:play:<song id>" — play that song now. */
  playPrefix: "mq:play:",
  /** "mq:del:<song id>" — remove that song from the queue. */
  deletePrefix: "mq:del:",
} as const;

/** Discord shows at most 25 options in one select menu. */
export const QUEUE_SELECT_MAX = 25;

/**
 * Stable id for a queued song. The queue's order changes all the time (skip, shuffle, delete…), so
 * a position in a customId would go stale; the id sticks to the Track object instead (the queue
 * hands out the same objects every time) and index.ts looks the song up again when it is clicked.
 */
const itemIds = new WeakMap<object, string>();
let nextItemId = 1;
export function queueItemId(track: object): string {
  let id = itemIds.get(track);
  if (!id) {
    id = `q${(nextItemId++).toString(36)}`;
    itemIds.set(track, id);
  }
  return id;
}

/**
 * The queue as a Dropdown Menu (one row, goes inside the player's Container).
 * The first 25 songs are listed, numbered like in the panel text and like "earth ลบคิว <เลข>".
 * Empty queue → a greyed-out menu with a single placeholder entry (Discord needs ≥ 1 option).
 */
export function buildQueueSelectRow(queue: QueueTrack[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(QUEUE_ID.select)
    .setMinValues(1)
    .setMaxValues(1);

  if (queue.length === 0) {
    menu
      .setPlaceholder("📋 คิวว่าง — ยังไม่มีเพลงรอ")
      .addOptions(new StringSelectMenuOptionBuilder().setLabel("ยังไม่มีเพลงในคิว").setValue("none"))
      .setDisabled(true);
  } else {
    const shown = queue.slice(0, QUEUE_SELECT_MAX);
    const count =
      queue.length > shown.length ? `แสดง ${shown.length} จาก ${queue.length}` : `${queue.length} เพลง`;
    menu
      .setPlaceholder(`📋 คิวเพลง (${count}) — เลือกเพื่อ เล่นเลย / ลบ`)
      .addOptions(
        shown.map((t, i) => {
          const info = [t.author ? clip(t.author, 50) : null, fmtMs(t.lengthMs)].filter(Boolean).join(" · ");
          return new StringSelectMenuOptionBuilder()
            .setLabel(`${i + 1}. ${clip(t.title, 90)}`) // label max 100 chars
            .setDescription(clip(info, 100))
            .setValue(queueItemId(t));
        }),
      );
  }
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/**
 * 16:9 YouTube thumbnail for the song panel. `thumbnailFor` gives hqdefault.jpg, which is 4:3 and
 * has black bars baked in above / below a 16:9 video; mqdefault.jpg is 16:9 with no bars.
 */
function itemThumbnail(track: QueueTrack): string | undefined {
  return thumbnailFor(track)?.replace("/hqdefault.jpg", "/mqdefault.jpg");
}

/**
 * What the person sees (ephemeral) after picking a song in the dropdown:
 * the song (with its thumbnail when it has one) and the two buttons ▶ เล่นเลย / 🗑 ลบออกจากคิว.
 */
export function buildQueueItemPanel(track: QueueTrack, position: number): ContainerBuilder {
  const lines = [`### <:1731discordprofileactivitywhite:1569242674307797042> เพลงในคิว #${position}`, `**${escapeMd(clip(track.title, 100))}**`];
  const info = [track.author ? escapeMd(clip(track.author, 60)) : null, fmtMs(track.lengthMs)]
    .filter(Boolean)
    .join(" · ");
  lines.push(`-# ${info}`);
  if (track.requestedBy) lines.push(`-# ขอเพลง โดย <@${track.requestedBy}>`);
  const text = new TextDisplayBuilder().setContent(lines.join("\n"));

  const container = new ContainerBuilder();
  const thumb = itemThumbnail(track);
  if (thumb) {
    // A Section needs an accessory; without a picture a plain TextDisplay does the job.
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)),
    );
  } else {
    container.addTextDisplayComponents(text);
  }

  const id = queueItemId(track);
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${QUEUE_ID.playPrefix}${id}`)
        .setLabel("เล่นเลย")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${QUEUE_ID.deletePrefix}${id}`)
        .setLabel("ลบออกจากคิว")
        .setStyle(ButtonStyle.Danger),
    ),
  );
  return container;
}

/** One-line result shown in place of the song panel once it has been used (no buttons left). */
export function buildQueueNotice(text: string): ContainerBuilder {
  return new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
}
