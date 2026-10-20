// ユウカ反映確認: 登録済みスラッシュコマンドと #雑談 の直近投稿を Discord API で読み、結果をファイルに書く（読み取りのみ）
// 使い方: DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... [DISCORD_GUILD_ID=...] node check_discord.mjs
const { DISCORD_BOT_TOKEN: token, DISCORD_APPLICATION_ID: app, DISCORD_GUILD_ID: guild } = process.env;
if (!token || !app) { console.error("DISCORD_BOT_TOKEN と DISCORD_APPLICATION_ID が必要です"); process.exit(1); }
const H = { Authorization: `Bot ${token}` };
const CHANNEL = "1521789822639935528";
const get = async (path) => { const r = await fetch(`https://discord.com/api/v10${path}`, { headers: H }); const body = await r.json().catch(() => ({})); return { status: r.status, body }; };
const result = { checked_at: new Date().toISOString() };
const me = await get("/users/@me"); result.bot = { status: me.status, username: me.body.username, id: me.body.id };
const paths = [["global", `/applications/${app}/commands`]]; if (guild) paths.push(["guild", `/applications/${app}/guilds/${guild}/commands`]);
result.commands = {};
for (const [kind, p] of paths) {
  const r = await get(p);
  const list = Array.isArray(r.body) ? r.body : [];
  const expense = list.find((c) => c.name === "expense");
  const listSub = expense?.options?.find((o) => o.name === "list");
  result.commands[kind] = {
    status: r.status, count: list.length, names: list.map((c) => c.name),
    expense_list_options: (listSub?.options ?? []).map((o) => ({ name: o.name, ja: o.name_localizations?.ja ?? null, description: o.description, choices: (o.choices ?? []).map((c) => `${c.name}=${c.value}`) }))
  };
}
const msgs = await get(`/channels/${CHANNEL}/messages?limit=10`);
const arr = Array.isArray(msgs.body) ? msgs.body : [];
result.chat = { status: msgs.status, error: Array.isArray(msgs.body) ? null : msgs.body, recent: arr.map((m) => ({ at: m.timestamp, author: m.author?.username, bot: !!m.author?.bot, head: (m.content ?? "").replace(/\n/g, " ").slice(0, 60) })) };
result.announce_20261020_found = arr.some((m) => (m.content ?? "").includes("先生、2つ直しました"));
const fs = await import("node:fs");
fs.writeFileSync("./discord_check_result.json", JSON.stringify(result, null, 2));
console.log("結果を書きました: ./discord_check_result.json");
console.log(`bot=${result.bot.username ?? "(取得失敗 " + me.status + ")"} / global commands=${result.commands.global.count} / 告知20261020=${result.announce_20261020_found ? "あり" : "なし"}`);
