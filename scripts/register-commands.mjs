const {
  DISCORD_BOT_TOKEN,
  DISCORD_APPLICATION_ID,
  DISCORD_GUILD_ID
} = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_APPLICATION_ID) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required.");
  process.exit(1);
}

const commands = [
  {
    name: "todo",
    description: "todoを管理します",
    options: [
      {
        type: 1,
        name: "add",
        description: "自然文からtodo登録候補を作ります",
        options: [{ type: 3, name: "text", description: "例: 明日までにレポートを出す", required: true }]
      },
      {
        type: 1,
        name: "list",
        description: "todo一覧を表示します",
        options: [
          {
            type: 3,
            name: "range",
            description: "表示範囲",
            required: false,
            choices: [
              { name: "today", value: "today" },
              { name: "week", value: "week" },
              { name: "all", value: "all" }
            ]
          }
        ]
      },
      {
        type: 1,
        name: "done",
        description: "todoを完了にします",
        options: [{ type: 4, name: "id", description: "todo ID。未指定なら候補ボタンを表示します", required: false }]
      }
    ]
  },
  {
    name: "reminder",
    description: "リマインダーを管理します",
    options: [
      {
        type: 1,
        name: "add",
        description: "自然文からリマインダー登録候補を作ります",
        options: [{ type: 3, name: "text", description: "例: 今日15時に電話する", required: true }]
      },
      { type: 1, name: "list", description: "未通知のリマインダー一覧を表示します" }
    ]
  },
  {
    name: "expense",
    description: "支出メモを確認します",
    options: [
      {
        type: 1,
        name: "list",
        description: "支出メモ一覧を表示します",
        options: [
          {
            type: 3,
            name: "range",
            description: "表示範囲",
            required: false,
            choices: [
              { name: "all", value: "all" },
              { name: "month", value: "month" }
            ]
          }
        ]
      }
    ]
  },
  {
    name: "request",
    description: "機能要望を確認します",
    options: [
      { type: 1, name: "list", description: "自分の機能要望一覧を表示します" }
    ]
  },
  {
    name: "guide",
    description: "ユウカに使い方を聞きます"
  },
  {
    name: "backup",
    description: "D1データのバックアップJSONを#報告に送ります"
  }
];

const base = `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}`;
const url = DISCORD_GUILD_ID
  ? `${base}/guilds/${DISCORD_GUILD_ID}/commands`
  : `${base}/commands`;

const response = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(commands)
});

const body = await response.text();
if (!response.ok) {
  console.error(`Failed: ${response.status} ${response.statusText}`);
  console.error(body);
  process.exit(1);
}

console.log("Registered commands:");
console.log(body);
