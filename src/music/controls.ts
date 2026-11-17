/**
 * The button rows under the player embed (Discord Message Components), laid out like the
 * reference screenshot — all grey, 5 per row:
 *
 *   row 1:  🔀 shuffle   ⏮ previous   ⏸/<:4303discordcategorycollapsedwhit:1569242059251130389> pause·resume   ⏭ next   🔁 loop
 *   row 2:  📋 queue     🔉 vol −      ⏹ stop              🔊 vol +    🕘 history
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
 *                     [ <:4303discordcategorycollapsedwhit:1569242059251130389> เล่นเลย ]  [ 🗑 ลบออกจากคิว ]
 *
 * index.ts handles it in handleQueueSelect / handleQueueButton.
 *
 * History dropdown (the 🕘 button, see the bottom of this file) — every song this server has
 * ever played, newest first, 25 per page:
 *
 *   🕘 ephemeral panel:  ### 🕘 ประวัติเพลงที่เคยเปิด
 *                        [ Dropdown: 25 songs of this page ▾ ]
 *                        [ ⏮ ] [ <:Gemini_Generated_Image_402sjg402:1569243289964519494> ] [ 2/5 ] [ <:4303discordcategorycollapsedwhit:1569242059251130389> ] [ ⏭ ]            ← only with more than one page
 *                        [ เปิดล่าสุด ] [ เปิดบ่อยสุด ]                ← sort order (the active one is blue)
 *        │ pick a song
 *        ▼
 *   same panel becomes: the song (+ thumbnail, play count, last played)
 *                        [ เล่นเลย ]  [ เพิ่มเข้าคิว ]  [ กลับไปรายการ ]
 *
 * index.ts handles it in handleHistorySelect / handleHistoryButton.
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
import type { HistoryEntry, HistorySort } from "./history.ts";
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
  history: "mc:history",
  volumeDown: "mc:voldown",
  stop: "mc:stop",
  volumeUp: "mc:volup",
} as const;

/** Volume change per click, in percent (same step as the "เพิ่มเสียง / เบาเสียง" voice commands). */
export const VOLUME_STEP = 5;

export interface ControlState {
  paused: boolean;
  loop: LoopMode;
  /** Nothing is playing: show every button (🕘 history included), but greyed out and unclickable. */
  disabled?: boolean;
  /** false = the song history is switched off (MUSIC_HISTORY=false), so 🕘 is greyed out. Default true. */
  history?: boolean;
}

const LOOP_EMOJI: Record<LoopMode, string> = { none: "<:Gemini_Generated_Image_hznznshzn:1569242460553482300>", track: "<:Gemini_Generated_Image_fwokl8fwo:1569246833492889651>", queue: "<:Gemini_Generated_Image_1bzb411bz:1569246870465810482>" };

/** Every button is grey (Secondary); loop's on/off state shows in its emoji and the panel text. */
export function buildControlRows({
  paused,
  loop,
  disabled = false,
  history = true,
}: ControlState): ActionRowBuilder<ButtonBuilder>[] {
  const btn = (id: string, emoji: string, off = disabled) =>
    new ButtonBuilder()
      .setCustomId(id)
      .setEmoji(emoji)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(off);

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
    // Greyed out like the others while nothing plays, and also when the song history is switched off.
    btn(CONTROL_ID.history, "<:8810datetime:1572098391519920209>", disabled || !history),
  );
  return [row1, row2];
}

// ─── Queue dropdown ──────────────────────────────────────────────────────────

/** customId prefix of the queue dropdown and of the <:4303discordcategorycollapsedwhit:1569242059251130389> / 🗑 buttons under a picked song. */
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
 * the song (with its thumbnail when it has one) and the two buttons <:4303discordcategorycollapsedwhit:1569242059251130389> เล่นเลย / 🗑 ลบออกจากคิว.
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

// ─── History dropdown (🕘 button) ────────────────────────────────────────────

/** customId prefix of everything inside the history panel (dropdown, page / sort buttons, <:4303discordcategorycollapsedwhit:1569242059251130389> / ➕ / back). */
export const HISTORY_PREFIX = "mh:";

/**
 * customIds inside the history panel. They all carry the sort order and the page number, so a
 * button can redraw the same view without any server-side state (the panel is an ephemeral
 * message, one per person). <sort> is "r" (most recently played) or "p" (most played).
 *   mh:pick:<sort>:<page>              the dropdown (its value is a video id)
 *   mh:page:<sort>:<page>              ⏮ <:Gemini_Generated_Image_402sjg402:1569243289964519494> <:4303discordcategorycollapsedwhit:1569242059251130389> ⏭, the two sort buttons (→ page 0) and "back to the list"
 *   mh:play:<sort>:<page>:<video id>   เล่นเลย
 *   mh:add:<sort>:<page>:<video id>    เพิ่มเข้าคิว
 */
export const HISTORY_ID = {
  pickPrefix: "mh:pick:",
  pagePrefix: "mh:page:",
  playPrefix: "mh:play:",
  addPrefix: "mh:add:",
  /** The "2/5" label between <:Gemini_Generated_Image_402sjg402:1569243289964519494> and <:4303discordcategorycollapsedwhit:1569242059251130389> — always disabled, so it has no handler. */
  indicator: "mh:noop",
} as const;

/** Songs per page = the most options Discord allows in one dropdown. */
export const HISTORY_PAGE_SIZE = QUEUE_SELECT_MAX;

/** The sort order the panel opens with. */
export const HISTORY_DEFAULT_SORT: HistorySort = "recent";

const SORT_CODE: Record<HistorySort, string> = { recent: "r", plays: "p" };
const SORT_FROM_CODE: Record<string, HistorySort> = { r: "recent", p: "plays" };
const SORT_TEXT: Record<HistorySort, string> = { recent: "เปิดล่าสุด", plays: "เปิดบ่อยสุด" };

/** customId of "show this page of this sort order". */
function pageId(sort: HistorySort, page: number): string {
  return `${HISTORY_ID.pagePrefix}${SORT_CODE[sort]}:${page}`;
}

export interface HistoryAction {
  kind: "pick" | "page" | "play" | "add";
  sort: HistorySort;
  /** 0-based page the panel was showing. */
  page: number;
  /** Only for play / add. */
  videoId: string | null;
}

const HISTORY_ID_RE = /^mh:(pick|page|play|add):([rp]):(\d{1,6})(?::([\w-]{11}))?$/;

/** customId → what was clicked; null for anything that is not a history id (or is malformed). */
export function parseHistoryId(customId: string): HistoryAction | null {
  const m = HISTORY_ID_RE.exec(customId);
  if (!m) return null;
  const kind = m[1] as HistoryAction["kind"];
  const sort = SORT_FROM_CODE[m[2] ?? ""];
  const videoId = m[4] ?? null;
  if (!sort) return null;
  if ((kind === "play" || kind === "add") && !videoId) return null;
  return { kind, sort, page: Number(m[3] ?? 0), videoId };
}

/** How many pages `total` songs make (at least 1, so an empty history still has "page 1"). */
export function historyPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
}

/** Keeps a page number inside 0 … pages-1 (the history can shrink or grow while a panel is open). */
export function clampHistoryPage(page: number, pages: number): number {
  const p = Number.isFinite(page) ? Math.trunc(page) : 0;
  return Math.min(Math.max(0, p), Math.max(1, pages) - 1);
}

export interface HistoryPanelInput {
  /** The songs of this page, in `sort` order (at most HISTORY_PAGE_SIZE). */
  entries: HistoryEntry[];
  sort: HistorySort;
  /** 0-based page being shown. */
  page: number;
  pages: number;
  /** Different songs in the whole history. */
  total: number;
  /** One line shown above the list: result of the last <:4303discordcategorycollapsedwhit:1569242059251130389> / ➕ ("กำลังเล่น …"). */
  notice?: string;
}

/**
 * The history panel: title, one dropdown with this page's songs, and — when there is something to
 * switch — the page row ⏮ <:Gemini_Generated_Image_402sjg402:1569243289964519494> 2/5 <:4303discordcategorycollapsedwhit:1569242059251130389> ⏭ and the sort row [เปิดล่าสุด] [เปิดบ่อยสุด]. An empty history is
 * just a hint — Discord does not allow an empty dropdown.
 */
export function buildHistoryPanel({ entries, sort, page, pages, total, notice }: HistoryPanelInput): ContainerBuilder {
  const lines = ["### <:8810datetime:1572098391519920209> ประวัติเพลงที่เคยเปิด"];
  if (total > 0) lines.push(`-# ทั้งหมด ${total} เพลง · หน้า ${page + 1}/${pages} · เรียงจาก${SORT_TEXT[sort]}`);
  if (notice) lines.push(notice);

  const container = new ContainerBuilder();
  if (total === 0 || entries.length === 0) {
    lines.push(total === 0 ? "ยังไม่มีเพลงในประวัติครับ — เปิดเพลงสักเพลง แล้วมันจะมาอยู่ที่นี่" : "หน้านี้ไม่มีเพลงแล้วครับ");
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
    if (total > 0 && pages > 1) container.addActionRowComponents(buildHistoryNavRow(page, pages, sort));
    return container;
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  const offset = page * HISTORY_PAGE_SIZE;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${HISTORY_ID.pickPrefix}${SORT_CODE[sort]}:${page}`)
    .setPlaceholder(`เลือกเพลงที่เคยเปิด (หน้า ${page + 1}/${pages})`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      entries.slice(0, HISTORY_PAGE_SIZE).map((e, i) => {
        const info = [e.author ? clip(e.author, 45) : null, fmtMs(e.lengthMs), `เปิด ${e.plays} ครั้ง`]
          .filter(Boolean)
          .join(" · ");
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${offset + i + 1}. ${clip(e.title, 88)}`) // label max 100 chars
          .setDescription(clip(info, 100))
          .setValue(e.videoId);
      }),
    );
  container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  if (pages > 1) container.addActionRowComponents(buildHistoryNavRow(page, pages, sort));
  // Sorting only changes anything with at least two songs.
  if (total > 1) container.addActionRowComponents(buildHistorySortRow(sort));
  return container;
}

/** ⏮ first · <:Gemini_Generated_Image_402sjg402:1569243289964519494> previous · "2/5" · <:4303discordcategorycollapsedwhit:1569242059251130389> next · ⏭ last (the ends grey out on the first / last page). */
function buildHistoryNavRow(page: number, pages: number, sort: HistorySort): ActionRowBuilder<ButtonBuilder> {
  const go = (label: string, target: number, off: boolean) =>
    new ButtonBuilder()
      .setCustomId(pageId(sort, target))
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(off);
  const first = page <= 0;
  const last = page >= pages - 1;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    go("⏮", 0, first),
    go("<:Gemini_Generated_Image_402sjg402:1569243289964519494>", page - 1, first),
    new ButtonBuilder()
      .setCustomId(HISTORY_ID.indicator)
      .setLabel(`${page + 1}/${pages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    go("<:4303discordcategorycollapsedwhit:1569242059251130389>", page + 1, last),
    go("⏭", pages - 1, last),
  );
}

/** [เปิดล่าสุด] [เปิดบ่อยสุด] — the active order is blue; either button jumps back to page 1 of that order. */
function buildHistorySortRow(sort: HistorySort): ActionRowBuilder<ButtonBuilder> {
  const btn = (which: HistorySort, emoji: string) =>
    new ButtonBuilder()
      .setCustomId(pageId(which, 0))
      .setEmoji(emoji)
      .setLabel(SORT_TEXT[which])
      .setStyle(which === sort ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(btn("recent", "🕘"), btn("plays", "🔥"));
}

/**
 * The panel after picking a song in the history dropdown: the song (with its 16:9 thumbnail),
 * how often / when it was played, and [เล่นเลย] [เพิ่มเข้าคิว] [กลับไปรายการ]. `sort` and `page`
 * ride along in the buttons so "back" and the result of <:4303discordcategorycollapsedwhit:1569242059251130389> / ➕ land on the same view.
 */
export function buildHistoryItemPanel(entry: HistoryEntry, page: number, sort: HistorySort): ContainerBuilder {
  const info = [entry.author ? escapeMd(clip(entry.author, 60)) : null, fmtMs(entry.lengthMs)]
    .filter(Boolean)
    .join(" · ");
  const text = new TextDisplayBuilder().setContent(
    [
      "### <:8810datetime:1572098391519920209> เพลงจากประวัติ",
      `**${escapeMd(clip(entry.title, 100))}**`,
      `-# ${info}`,
      `-# เคยเปิด ${entry.plays} ครั้ง · ล่าสุด <t:${Math.floor(entry.lastPlayedAt / 1000)}:R>`,
    ].join("\n"),
  );
  // Videos have always had mqdefault.jpg (16:9, no black bars, unlike hqdefault).
  const thumb = `https://i.ytimg.com/vi/${encodeURIComponent(entry.videoId)}/mqdefault.jpg`;
  const where = `${SORT_CODE[sort]}:${page}`;

  const container = new ContainerBuilder().addSectionComponents(
    new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)),
  );
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${HISTORY_ID.playPrefix}${where}:${entry.videoId}`)
        .setLabel("เล่นเลย")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${HISTORY_ID.addPrefix}${where}:${entry.videoId}`)
        .setLabel("เพิ่มเข้าคิว")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(pageId(sort, page))
        .setLabel("กลับไปรายการ")
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return container;
}
