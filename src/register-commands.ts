#!/usr/bin/env bun
/**
 * One-shot: register /earth slash commands GLOBALLY (so they work in DM too).
 *
 * Usage:
 *   bun src/register-commands.ts
 *
 * Reads DISCORD_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID from .env.
 *
 * - Clears any leftover guild-scoped commands at DISCORD_GUILD_ID (so users
 *   don't see duplicates in that guild's autocomplete during/after transition).
 * - Pushes commands globally — propagation can take up to ~1hr in the Discord
 *   client cache. Restart Discord client to force a refresh sooner.
 */
import { REST, Routes } from "discord.js";
import { commands } from "./commands.ts";

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APP_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !appId) {
  console.error("[register] Missing DISCORD_TOKEN or DISCORD_APP_ID in .env");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);
const body = commands.map((c) => c.toJSON());

try {
  if (guildId) {
    console.log(`[register] Clearing guild-scoped commands at ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [] });
    console.log(`[register] ✅ guild cleared`);
  }

  console.log(`[register] Pushing ${commands.length} command(s) globally...`);
  const data = (await rest.put(Routes.applicationCommands(appId), {
    body,
  })) as unknown[];
  console.log(`[register] ✅ registered ${data.length} command(s) globally`);
  for (const cmd of body) {
    console.log(`  - /${cmd.name} (${cmd.description})`);
  }
  console.log(
    `[register] ℹ️ Discord client cache propagation: up to ~1hr (restart client to force refresh).`,
  );
  process.exit(0);
} catch (e: any) {
  console.error("[register] ❌ failed:", e?.message || e);
  process.exit(1);
}
