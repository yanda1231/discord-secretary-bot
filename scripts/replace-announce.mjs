// 告知の差し替え: #雑談 にある bot 自身の「先生、2つ直しました」投稿を削除し、指定ファイルの本文を新しく投稿する
// 使い方: DISCORD_BOT_TOKEN=... node replace_announce.mjs <新しい告知ファイル>
const token = process.env.DISCORD_BOT_TOKEN; const file = process.argv[2];
if (!token || !file) { console.error("DISCORD_BOT_TOKEN と 告知ファイルが必要です"); process.exit(1); }
const fs = await import("node:fs"); const content = fs.readFileSync(file, "utf8").trim();
const H = { Authorization: `Bot ${token}`, "Content-Type": "application/json" }; const CHANNEL = "1521789822639935528"; const API = "https://discord.com/api/v10";
const me = await (await fetch(`${API}/users/@me`, { headers: H })).json();
const msgs = await (await fetch(`${API}/channels/${CHANNEL}/messages?limit=20`, { headers: H })).json();
const old = (Array.isArray(msgs) ? msgs : []).filter((m) => m.author?.id === me.id && (m.content ?? "").includes("先生、2つ直しました"));
for (const m of old) { const r = await fetch(`${API}/channels/${CHANNEL}/messages/${m.id}`, { method: "DELETE", headers: H }); console.log(`削除 ${m.id} (${m.timestamp}) -> ${r.status}`); }
const post = await fetch(`${API}/channels/${CHANNEL}/messages`, { method: "POST", headers: H, body: JSON.stringify({ content }) });
console.log(`新しい告知を投稿 -> ${post.status}`); if (!post.ok) console.log(await post.text());
