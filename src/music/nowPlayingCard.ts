/**
 * Renders the "now playing" card — blurred album art as the background, the sharp album art
 * on the left, title / artist, and a progress bar (or a LIVE badge for streams) — as a PNG
 * attached to the player's Components V2 message (see index.ts). There is no separate corner-cover
 * render: that used to feed a Discord embed's `thumbnail` field, but the panel dropped its
 * embed entirely, and this card already draws the album art inline on the left, so a second
 * cropped copy had nothing left to do.
 *
 * Install:  bun add @napi-rs/canvas
 *   (pure npm binary, Skia-based — unlike the old "canvas" package it needs no
 *   system Cairo/Pango, which matters if this ever runs on a minimal server.)
 *
 * Artwork: `track.artworkUrl` comes straight from Lavalink (the youtube-source plugin fills it
 * in with the video's thumbnail). It's usually a maxresdefault.jpg, and YouTube returns a tiny
 * 120×90 grey placeholder (HTTP 200, not a 404) for videos that don't have one at that size —
 * loadArtwork() treats anything that small as "missing" and falls back to sddefault/hqdefault,
 * which YouTube always has.
 *
 * Black bars: YouTube pads art-track thumbnails with black (the square cover sits in the
 * middle of a 16:9 / 4:3 frame). trimBlackBars() crops that padding off first, so the cover,
 * the blurred background and the thumbnail all show only the real artwork.
 *
 * Size: Discord shows an attached image at its own pixel size (capped by the container), so
 * the card is drawn small (W × H below) to stay about as wide as the row of 5 buttons under it.
 * Raising W makes the card — and the whole container — wider than the button row.
 *
 * Blur: uses the canvas `filter = "blur(Npx)"` property (supported by @napi-rs/canvas / Skia).
 * Change BLUR_PX below for a softer or sharper background.
 *
 * Fonts: canvas's default font may not have Thai/CJK glyphs depending on the
 * server it runs on. Drop a font file at FONT_PATH (e.g. Noto Sans Thai, free:
 * https://fonts.google.com/noto/specimen/Noto+Sans+Thai) and it's registered
 * automatically; without it this just falls back to the system sans-serif.
 */
import {
  createCanvas,
  loadImage,
  GlobalFonts,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Track } from "./lavalink.ts";

const FONT_PATH = path.join(import.meta.dir, "fonts", "NotoSansThai-Regular.ttf");
const FONT_FAMILY_NAME = "NowPlayingSans";

let fontFamily: string | null = null; // resolved on first render, then cached
function ensureFont(): string {
  if (fontFamily) return fontFamily;
  fontFamily = "sans-serif";
  if (existsSync(FONT_PATH)) {
    try {
      GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY_NAME);
      fontFamily = FONT_FAMILY_NAME;
    } catch (e) {
      console.warn("[music] could not register card font, using system default:", e);
    }
  }
  return fontFamily;
}
const fontCss = (family: string, weight: "normal" | "bold", px: number) =>
  `${weight === "bold" ? "bold " : ""}${px}px "${family}"`;

// ─── Layout ───────────────────────────────────────────────────────────────
const W = 400; // card width in px — Discord shows the image at about this size (360 → 400, a bit longer)
const H = 124; // like the reference
const PAD = 11;
const ART = H - PAD * 2;
const CARD_RADIUS = 30; // very round corners, like the reference
const ART_RADIUS = 25;

// Text column (y values are the vertical centre of each line).
const TEXT_GAP = 24; // between the artwork and the text
const TEXT_RIGHT_PAD = 44; // the bar and the right-hand time stop short of the card edge
const TITLE_Y = 33;
const AUTHOR_Y = 53;
const BAR_Y = 80;
const TIME_Y = 95;

/** Background blur radius in px (at the 360px card width). */
const BLUR_PX = 20;

const BG_TOP = "#1b1d24"; // fallback background when there is no artwork
const BG_BOTTOM = "#121319";
const TEXT_PRIMARY = "#ffffff";
const TEXT_MUTED = "rgba(255,255,255,0.68)";
const TRACK_BG = "rgba(255,255,255,0.22)";
const BAR_FILL = "#ffffff";
const LIVE_RED = "#e5484d";

// ─── Artwork ──────────────────────────────────────────────────────────────
// Anything this small is YouTube's "no thumbnail at this size" placeholder, not real art.
const PLACEHOLDER_MAX_WIDTH = 121;

function youtubeThumbUrls(identifier: string): string[] {
  return [
    `https://i.ytimg.com/vi/${identifier}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${identifier}/hqdefault.jpg`,
  ];
}

/** Artwork as drawn: the loaded image, or a cropped copy of it once the black bars are gone. */
type Art = Image | Canvas;

const BLACK_MAX = 28; // a pixel counts as "black" when r, g and b are all ≤ this (JPEG noise allowed)
const BLACK_LINE_SHARE = 0.985; // a row/column is a bar when ≥ this share of its pixels is black
const TRIM_INSET = 2; // px (source size) trimmed extra on each cut side — JPEG blurs the bar's edge
const MIN_KEEP = 0.4; // never trim away more than 60% of a side (a genuinely dark cover stays as is)
const SCAN_MAX = 400; // the scan runs on a copy at most this many px wide/tall, for speed

/**
 * Crop the black bars off the edges of `img` (letterbox / pillarbox padding).
 * Returns `img` itself when there are none, or when trimming would eat most of the picture.
 */
export function trimBlackBars(img: Image): Art {
  const scale = Math.min(1, SCAN_MAX / Math.max(img.width, img.height));
  const sw = Math.max(1, Math.round(img.width * scale));
  const sh = Math.max(1, Math.round(img.height * scale));
  const probe = createCanvas(sw, sh);
  const pctx = probe.getContext("2d");
  pctx.drawImage(img, 0, 0, sw, sh);
  const { data } = pctx.getImageData(0, 0, sw, sh);

  const isBlack = (x: number, y: number): boolean => {
    const i = (y * sw + x) * 4;
    return data[i]! <= BLACK_MAX && data[i + 1]! <= BLACK_MAX && data[i + 2]! <= BLACK_MAX;
  };
  const rowIsBar = (y: number, x0: number, x1: number): boolean => {
    let black = 0;
    for (let x = x0; x < x1; x++) if (isBlack(x, y)) black++;
    return black >= (x1 - x0) * BLACK_LINE_SHARE;
  };
  const colIsBar = (x: number, y0: number, y1: number): boolean => {
    let black = 0;
    for (let y = y0; y < y1; y++) if (isBlack(x, y)) black++;
    return black >= (y1 - y0) * BLACK_LINE_SHARE;
  };

  let top = 0;
  let bottom = sh;
  let left = 0;
  let right = sw;
  // Two passes: trimming the sides can expose more bar on the top/bottom (and vice versa).
  for (let pass = 0; pass < 2; pass++) {
    while (top < bottom && rowIsBar(top, left, right)) top++;
    while (bottom > top && rowIsBar(bottom - 1, left, right)) bottom--;
    while (left < right && colIsBar(left, top, bottom)) left++;
    while (right > left && colIsBar(right - 1, top, bottom)) right--;
  }

  if (top === 0 && bottom === sh && left === 0 && right === sw) return img; // no bars
  if (right - left < sw * MIN_KEEP || bottom - top < sh * MIN_KEEP) return img; // mostly black: leave it

  const x0 = left > 0 ? Math.round(left / scale) + TRIM_INSET : 0;
  const y0 = top > 0 ? Math.round(top / scale) + TRIM_INSET : 0;
  const x1 = right < sw ? Math.round(right / scale) - TRIM_INSET : img.width;
  const y1 = bottom < sh ? Math.round(bottom / scale) - TRIM_INSET : img.height;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 16 || h < 16) return img;

  const out = createCanvas(w, h);
  out.getContext("2d").drawImage(img, x0, y0, w, h, 0, 0, w, h);
  return out;
}

async function loadArtwork(track: Track): Promise<Art | null> {
  const candidates = [
    ...(track.artworkUrl ? [track.artworkUrl] : []),
    ...(track.identifier ? youtubeThumbUrls(track.identifier) : []),
  ];
  for (const url of candidates) {
    try {
      const img = await loadImage(url);
      if (img.width > PLACEHOLDER_MAX_WIDTH) return trimBlackBars(img);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ─── Small drawing helpers ──────────────────────────────────────────────────
function roundedRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fmtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Binary-search the longest prefix of `text` (+ "…") that fits in `maxWidth` at the current ctx.font. */
function ellipsize(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ell = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + ell).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ell;
}

/** Draw `img` so it covers the (x, y, w, h) box completely (centered, cropped). */
function drawCover(ctx: SKRSContext2D, img: Art, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** Blurred, darkened copy of the artwork filling the whole card (or a plain gradient without art). */
function drawBackground(ctx: SKRSContext2D, art: Art | null): void {
  if (!art) {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, BG_TOP);
    bg.addColorStop(1, BG_BOTTOM);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    return;
  }

  // Blur fades to transparent at the canvas edges, so draw the art oversized: the faded
  // rim then falls outside the card.
  const m = BLUR_PX * 3;
  ctx.save();
  ctx.filter = `blur(${BLUR_PX}px)`;
  drawCover(ctx, art, -m, -m, W + m * 2, H + m * 2);
  ctx.restore(); // drops the filter again

  // Dark wash so white text stays readable on bright covers — heavier toward the text side,
  // but light enough that the blurred colours of the cover still show.
  const wash = ctx.createLinearGradient(0, 0, W, 0);
  wash.addColorStop(0, "rgba(8,8,12,0.50)");
  wash.addColorStop(1, "rgba(8,8,12,0.66)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);
}

/** Two white bars on a dim veil over the artwork square — the "paused" marker (no emoji font needed). */
function drawPausedMark(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(x, y, size, size);
  const barW = 9;
  const barH = 30;
  const gap = 10;
  const bx = x + (size - (barW * 2 + gap)) / 2;
  const by = y + (size - barH) / 2;
  ctx.fillStyle = "#ffffff";
  roundedRectPath(ctx, bx, by, barW, barH, 3);
  ctx.fill();
  roundedRectPath(ctx, bx + barW + gap, by, barW, barH, 3);
  ctx.fill();
}

// ─── Main render ──────────────────────────────────────────────────────────
export interface NowPlayingOptions {
  /** Draw the paused marker over the artwork. */
  paused?: boolean;
}

/**
 * `elapsedMs` is how far into the song we are *right now* (pause-aware —
 * use `music.positionMs(guildId)`). The card is a still picture: it shows the position at
 * the moment it was drawn and is redrawn whenever the player embed is refreshed.
 */
export async function renderNowPlaying(
  track: Track,
  elapsedMs: number,
  opts: NowPlayingOptions = {},
): Promise<Buffer> {
  const family = ensureFont();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const art = await loadArtwork(track);

  // Clip the whole canvas to a rounded rect so the corners stay transparent —
  // the card then floats on the embed's own background instead of showing a hard box.
  roundedRectPath(ctx, 0, 0, W, H, CARD_RADIUS);
  ctx.clip();

  drawBackground(ctx, art);

  // Album art (cover-fit into a rounded square, with a soft shadow so it lifts off the blur).
  const artX = PAD;
  const artY = PAD;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = "#000000";
  roundedRectPath(ctx, artX, artY, ART, ART, ART_RADIUS);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRectPath(ctx, artX, artY, ART, ART, ART_RADIUS);
  ctx.clip();
  if (art) {
    drawCover(ctx, art, artX, artY, ART, ART);
  } else {
    ctx.fillStyle = "#33313d";
    ctx.fillRect(artX, artY, ART, ART);
  }
  if (opts.paused) drawPausedMark(ctx, artX, artY, ART);
  ctx.restore(); // back to the outer (card-only) clip

  // Text column: title, artist, thin progress bar, then the two times — no "Playing from" line.
  const textX = artX + ART + TEXT_GAP;
  const textW = W - textX - TEXT_RIGHT_PAD;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = fontCss(family, "bold", 18);
  ctx.fillText(ellipsize(ctx, track.title, textW), textX, TITLE_Y);

  if (track.author) {
    ctx.fillStyle = TEXT_MUTED;
    ctx.font = fontCss(family, "normal", 14);
    ctx.fillText(ellipsize(ctx, track.author, textW), textX, AUTHOR_Y);
  }

  // Progress bar, or a LIVE badge when there's no real duration to show.
  const isLive = track.isStream || !(track.lengthMs > 0);
  if (isLive) {
    roundedRectPath(ctx, textX, BAR_Y - 10, 44, 20, 6);
    ctx.fillStyle = LIVE_RED;
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = fontCss(family, "bold", 11);
    ctx.textAlign = "center";
    ctx.fillText("LIVE", textX + 22, BAR_Y);
    ctx.textAlign = "left";
  } else {
    const elapsed = Math.min(Math.max(elapsedMs, 0), track.lengthMs);
    const ratio = elapsed / track.lengthMs;
    const x0 = textX + 3; // round caps stick out by half the line width
    const x1 = textX + textW - 3;

    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.strokeStyle = TRACK_BG;
    ctx.beginPath();
    ctx.moveTo(x0, BAR_Y);
    ctx.lineTo(x1, BAR_Y);
    ctx.stroke();

    if (ratio > 0) {
      ctx.strokeStyle = BAR_FILL;
      ctx.beginPath();
      ctx.moveTo(x0, BAR_Y);
      ctx.lineTo(x0 + (x1 - x0) * ratio, BAR_Y);
      ctx.stroke();
    }

    ctx.fillStyle = TEXT_PRIMARY;
    ctx.font = fontCss(family, "normal", 11);
    ctx.fillText(fmtTime(elapsed), textX, TIME_Y);
    ctx.textAlign = "right";
    ctx.fillText(fmtTime(track.lengthMs), textX + textW, TIME_Y);
    ctx.textAlign = "left";
  }

  return canvas.encode("png");
}

// ─── Idle card (nothing playing) ────────────────────────────────────────────
// Same geometry as the playing card, and now the same blurred-gradient background (no
// artwork to blur, so it's drawBackground's plain-gradient fallback): a dark rounded square
// with a music-note icon where the cover would be, "Waiting for a song…", an empty bar and
// "0:00 / --:--".
const IDLE_ART_BG = "#1b1b1b";
const IDLE_ICON = "#6f6f6f";
const IDLE_MUTED = "rgba(255,255,255,0.42)";
const IDLE_TRACK = "rgba(255,255,255,0.09)";

/** Outlined beamed double note (♫), drawn as paths so no emoji font is needed. */
function drawMusicNote(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  // The note is laid out in a 0..1 square, then shrunk to ~31% of the cover and centred.
  const K = 0.78;
  const P = (u: number, v: number): [number, number] => [
    x + (0.5 + (u - 0.47) * K) * size,
    y + (0.49 + (v - 0.52) * K) * size,
  ];
  ctx.save();
  ctx.strokeStyle = IDLE_ICON;
  ctx.lineWidth = Math.max(1.5, size * 0.021);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // note heads
  for (const [u, v] of [
    [0.355, 0.68],
    [0.59, 0.614],
  ] as const) {
    const [cx, cy] = P(u, v);
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.075 * K, 0, Math.PI * 2);
    ctx.stroke();
  }
  // stems
  for (const [u, v0, v1] of [
    [0.43, 0.68, 0.4],
    [0.668, 0.614, 0.325],
  ] as const) {
    const [sx, sy0] = P(u, v0);
    const [, sy1] = P(u, v1);
    ctx.beginPath();
    ctx.moveTo(sx, sy0);
    ctx.lineTo(sx, sy1);
    ctx.stroke();
  }
  // beam (outlined band between the two stems)
  ctx.beginPath();
  const pts = [P(0.43, 0.4), P(0.668, 0.325), P(0.668, 0.425), P(0.43, 0.5)];
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (const [px, py] of pts.slice(1)) ctx.lineTo(px, py);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

async function drawIdleCard(): Promise<Buffer> {
  const family = ensureFont();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  roundedRectPath(ctx, 0, 0, W, H, CARD_RADIUS);
  ctx.clip();
  // Same blurred-background treatment as the playing card (drawBackground with no artwork
  // falls back to this gradient) instead of a flat fill, so the idle card reads as "blurred"
  // too rather than a plain dark box.
  drawBackground(ctx, null);

  // Placeholder cover with the note icon.
  ctx.fillStyle = IDLE_ART_BG;
  roundedRectPath(ctx, PAD, PAD, ART, ART, ART_RADIUS);
  ctx.fill();
  drawMusicNote(ctx, PAD, PAD, ART);

  const textX = PAD + ART + TEXT_GAP;
  const textW = W - textX - TEXT_RIGHT_PAD;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = fontCss(family, "bold", 18);
  ctx.fillText(ellipsize(ctx, "Waiting for a song...", textW), textX, TITLE_Y);

  ctx.fillStyle = IDLE_MUTED;
  ctx.font = fontCss(family, "normal", 14);
  ctx.fillText(ellipsize(ctx, "กำลังรอเพลง...", textW), textX, AUTHOR_Y);

  // Empty bar.
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.strokeStyle = IDLE_TRACK;
  ctx.beginPath();
  ctx.moveTo(textX + 3, BAR_Y);
  ctx.lineTo(textX + textW - 3, BAR_Y);
  ctx.stroke();

  ctx.fillStyle = IDLE_MUTED;
  ctx.font = fontCss(family, "normal", 11);
  ctx.fillText("0:00", textX, TIME_Y);
  ctx.textAlign = "right";
  ctx.fillText("--:--", textX + textW, TIME_Y);
  ctx.textAlign = "left";

  return canvas.encode("png");
}

let idleCard: Promise<Buffer> | null = null;
/** The "nothing playing" card. It never changes, so it is drawn once and reused. */
export function renderIdleCard(): Promise<Buffer> {
  idleCard ??= drawIdleCard().catch((e) => {
    idleCard = null; // don't cache a failure
    throw e;
  });
  return idleCard;
}
