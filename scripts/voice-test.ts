import { Client, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from "@discordjs/voice";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("ready", async () => {
  console.log("Logged in:", client.user?.tag);
  const guild = client.guilds.cache.first();
  if (!guild) { console.log("No guild"); process.exit(1); }
  
  const channel = guild.channels.cache.get(process.env.TEST_CHANNEL_ID ?? "");
  if (!channel) { console.log("No channel"); process.exit(1); }
  
  console.log("Joining", channel.name);
  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });
  
  conn.on("stateChange", (o, n) => console.log(`State: ${o.status} → ${n.status}`));
  
  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
    console.log("CONNECTED!");
    setTimeout(() => { conn.destroy(); process.exit(0); }, 3000);
  } catch (e) {
    console.log("FAILED:", e);
    conn.destroy();
    process.exit(1);
  }
});

client.login(process.env.DISCORD_TOKEN);
