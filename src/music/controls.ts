/**
 * The button rows under the player embed (Discord Message Components), laid out like the
 * reference screenshot — all grey, 5 per row:
 *
 *   row 1:  🔀 shuffle   ⏮ previous   ⏸/▶ pause·resume   ⏭ next   🔁 loop
 *   row 2:  📋 queue     🔉 vol −      ⏹ stop              🔊 vol +    (blank, disabled)
 *
 * Only the ids and the look live here; what each button does is handled in index.ts
 * (handleControlButton), which switches on these ids.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { LoopMode } from "./queue.ts";

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
