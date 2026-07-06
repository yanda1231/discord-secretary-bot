import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_WELCOME_CHANNEL_ID ?? process.argv[2];

if (!token || !channelId) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_WELCOME_CHANNEL_ID are required.");
  console.error("Usage:");
  console.error('  DISCORD_BOT_TOKEN="Bot Token" DISCORD_WELCOME_CHANNEL_ID="channel id" npm run welcome:post');
  console.error('  or: DISCORD_BOT_TOKEN="Bot Token" npm run welcome:post -- "channel id"');
  process.exit(1);
}

const messagePath = resolve("WELCOME_MESSAGE.md");
const message = (await readFile(messagePath, "utf8")).trim();

if (message.length > 2000) {
  console.error(`WELCOME_MESSAGE.md is ${message.length} characters. Discord messages must be 2000 characters or less.`);
  process.exit(1);
}

const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
  method: "POST",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ content: message })
});

const body = await response.text();
if (!response.ok) {
  console.error(`Failed to post welcome message: ${response.status} ${response.statusText}`);
  console.error(body);
  process.exit(1);
}

console.log(`Posted welcome message to ${channelId}.`);
