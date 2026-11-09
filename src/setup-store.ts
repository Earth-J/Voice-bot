/**
 * Per-guild "setup" channel — the text channel set with `/earth setup`.
 *
 *  - typing a song name there (no prefix) plays / queues it
 *  - the live player embed (also for voice commands) lives there
 *
 * Saved in a small JSON file so it survives restarts:
 *
 *     { "<guildId>": { "channelId": "...", "messageId": "..." } }
 *
 * `messageId` is the persistent player-embed message, so after a restart the bot
 * edits the same message instead of posting a new one.
 *
 * On Railway the container filesystem is wiped on every deploy — mount a Volume at
 * the DATA_DIR folder (default ./data) to keep it (see DEPLOY-RAILWAY.md).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SetupEntry {
  channelId: string;
  /** The persistent player-embed message in `channelId`. */
  messageId?: string;
}

export class SetupStore {
  private map = new Map<string, SetupEntry>();

  constructor(private readonly file: string) {}

  /** Read the file. A missing or corrupt file just means "nothing set up yet". */
  load(): void {
    this.map.clear();
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return; // first run
    }
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      for (const [guildId, v] of Object.entries(data)) {
        const e = v as Partial<SetupEntry> | null;
        if (e && typeof e.channelId === "string" && e.channelId) {
          this.map.set(guildId, {
            channelId: e.channelId,
            ...(typeof e.messageId === "string" && e.messageId ? { messageId: e.messageId } : {}),
          });
        }
      }
    } catch (e: any) {
      console.warn(`[setup] ${this.file} is not valid JSON — ignoring it:`, e?.message ?? e);
    }
  }

  get(guildId: string): SetupEntry | undefined {
    return this.map.get(guildId);
  }

  guildIds(): string[] {
    return [...this.map.keys()];
  }

  /** Save (or replace) a guild's setup. */
  set(guildId: string, entry: SetupEntry): void {
    this.map.set(guildId, { ...entry });
    this.save();
  }

  delete(guildId: string): void {
    if (this.map.delete(guildId)) this.save();
  }

  /** Which guild (if any) has `channelId` as its setup channel. */
  guildForChannel(channelId: string): string | null {
    for (const [guildId, e] of this.map) if (e.channelId === channelId) return guildId;
    return null;
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2));
      renameSync(tmp, this.file); // atomic: never leaves a half-written file
    } catch (e: any) {
      // Not fatal — the setup still works until the next restart.
      console.warn(`[setup] could not save ${this.file}:`, e?.message ?? e);
    }
  }
}
