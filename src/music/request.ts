/**
 * Typed song requests in the setup channel (no prefix — the whole message is the song name).
 * Pure function, so it is easy to test.
 */

import { extractYouTubePlaylistUrl, extractYouTubeUrl } from "./query.ts";

/** Longer than this is chat, not a song name. */
export const MAX_REQUEST_CHARS = 150;

/** A YouTube link can be long (si=, list=, index=, pp= …), so it gets a bigger allowance. */
export const MAX_LINK_REQUEST_CHARS = 500;

/**
 * Message text → song query, or null when the message should be ignored
 * (empty, attachment/sticker only, or too long to be a song name).
 * A message containing a YouTube link becomes just that link (canonical watch URL, or
 * canonical playlist URL for a playlist link; a video link with `&list=` stays a single video).
 */
export function parseSongRequest(content: string): string | null {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const link = extractYouTubeUrl(text) ?? extractYouTubePlaylistUrl(text);
  if (link) return text.length <= MAX_LINK_REQUEST_CHARS ? link : null;
  if (text.length > MAX_REQUEST_CHARS) return null;
  return text;
}
