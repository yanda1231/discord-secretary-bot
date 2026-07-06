# Discord秘書bot（Mac版）

Discord上でtodo、リマインダー、雑談、朝会、夜締めを扱う個人用の秘書botです。Cloudflare Workers、Cloudflare D1、Gemini API、Discord Bot APIで動きます。

通常メッセージはDiscord Gatewayで常時接続せず、Cloudflare Cronで1分ごとに対象チャンネルを見に行く方式です。常時起動PCなしで運用できます。

## 現在できること

- `#todo` に自然文を書くと、Geminiでtodo候補を作り、確認ボタン後にD1へ保存
- 期限未設定のtodo候補は、確認画面から自然文で期限を追加
- `#reminder` に自然文を書くと、Geminiでリマインダー候補を作り、確認ボタン後にD1へ保存
- 日時未設定のリマインダー候補は、確認画面から自然文で日時を追加
- `#雑談` で普通の会話、todo候補抽出、リマインダー候補抽出、完了候補確認
- `#雑談` で支出・浪費メモ候補を抽出し、確認後に保存
- `#設定` に `.md` を添付して、長文ペルソナ設定をD1へ保存
- `#設定` の文章でチャンネルID、朝会、夜締め、事前通知を変更
- `/todo list` でtodo一覧を表示し、ボタンで完了
- `/todo done` はIDなしでも未完了todoの候補ボタンを表示
- `/reminder list` で未通知リマインダーを表示し、ボタンで削除
- `/expense list` で支出メモ一覧とカテゴリ別合計を表示
- `/guide` で使えるスラッシュコマンドを表示
- 事前通知と実時間通知の2段階リマインド
- リマインダー時刻の通知から対応済み・スヌーズを選択
- 毎朝の作戦会議、夜の締め
- 朝の作戦会議の最後にGemini生成の締め一文
- 期限や件数が詰まっている時のリスク注意
- 期限超過1日目/2日目の判定
- 期限超過2日目以降、または一定日数残ったtodoへの因数分解提案
- 同じ日に予定/todoが6件以上ある時のレア台詞
- 月末昼の支出レポート
- `毎週月曜9時にゴミ出し` のような自然文で繰り返しリマインダーを登録（通知後に次回分を自動予約、短い月の31日は月末扱い、スヌーズは当該回のみの単発扱い）
- `/backup` と月初の自動バックアップで、D1の全データをJSONとして `#報告` に添付
- Gemini障害時フォールバック（同一メッセージ最大5回再試行、上限到達で定型文返信、連続失敗30分で `#報告` に一度だけ通知、復旧でリセット）

標準のGeminiモデルは `gemini-3.5-flash` です。変更したい場合は `wrangler.toml` の `GEMINI_MODEL` を変更してください。

## 重要な仕様

- 自然文への反応は最大1分ほど遅れます。
- Discord Developer Portalで `MESSAGE CONTENT INTENT` をONにする必要があります。
- 登録は自動確定しません。todo/reminder/done候補は必ずDiscordボタンで確認します。
- `#つぶやき` は独り言・メモ代わりに使うチャンネルです。通常のAI応答やtodo登録は発生しません。
- 確認ボタンは30分で期限切れになります。期限切れ後に押した場合も、作り直しやすいように候補内容は表示します。
- Cloudflare WorkerはAIそのものではありません。WorkerがDiscord、D1、Gemini APIをつないで動かしています。
- ユウカらしい定型文は `src/yuuka-phrases.ts` にまとめています。Discord上ではなく、コード側で差し替える想定です。

## 初回セットアップ

### 1. Discord Botを作る

1. Discord Developer PortalでApplicationを作成
2. Botを作成
3. Public Key、Application ID、Bot Tokenを控える
4. `Bot` 設定で `MESSAGE CONTENT INTENT` をON
5. OAuth2 URL Generatorで `bot` と `applications.commands` を選択
6. Bot権限は最低限 `Send Messages`、`Read Message History`、`View Channels`、`Use Slash Commands` を付与
7. 生成されたURLでサーバーにBotを招待

### 2. Cloudflare D1を作る

```bash
npx wrangler d1 create discord_secretary_bot
```

表示された `database_id` を `wrangler.toml` の `database_id` に入れます。

### 3. 依存関係を入れる

```bash
npm install
```

### 4. D1マイグレーションを適用

```bash
npm run db:remote
```

ローカル開発だけなら:

```bash
npm run db:local
```

### 5. Secretsを設定

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put REPORT_CHANNEL_ID
```

### 6. デプロイ

```bash
npm run deploy
```

デプロイ後に表示されるWorkers URLをDiscord Developer Portalの `Interactions Endpoint URL` に設定します。

### 7. スラッシュコマンド登録

開発中は反映が速いGuildコマンドがおすすめです。

```bash
DISCORD_BOT_TOKEN="..." \
DISCORD_APPLICATION_ID="..." \
DISCORD_GUILD_ID="..." \
npm run register
```

これはMacのターミナルで実行します。Discordの `#設定` には貼りません。実際のBot TokenをDiscordに投稿してしまった場合は、Discord Developer PortalでTokenをリセットしてください。

## 自然文チャンネル設定

デプロイ後、Discordの `#設定` に以下を投稿します。IDはDiscordで各チャンネルを右クリックしてコピーします。

```text
todo: ここに#todoのチャンネルID
reminder: ここに#reminderのチャンネルID
雑談: ここに#雑談のチャンネルID
報告: ここに#報告のチャンネルID
朝: 07:00
夜: 22:30
事前通知: 15
```

事前通知の設定例:

```text
事前通知: 15
事前通知: 30
事前通知: なし
事前通知モード: 毎回
事前通知モード: 固定
事前通知モード: オフ
```

`事前通知モード: 毎回` の場合、登録確認の時に `事前通知を設定` と `事前通知を設定しない` ボタンが出ます。入力欄では `なし`、`15分前`、`15ふんまえ`、`1時間前`、`120` のように指定できます。数字だけの場合は分として扱うため、`120` は120分前、つまり2時間前です。固定モードでは `#設定` の分数を自動適用します。

## 使い方

### todo

`#todo` に自然文を書きます。

```text
明日までに資料を作る
```

またはスラッシュコマンドでも登録できます。

```text
/todo add text: 明日までに資料を作る
```

一覧:

```text
/todo list
/todo list range: today
/todo list range: week
/todo list range: all
```

`range` を省略すると `all` として表示します。一覧には完了ボタンも表示されます。

期限が読み取れなかったtodo候補には `期限を設定` ボタンが出ます。押すと入力欄が開き、`明日18時`、`今日22時` のような自然文で期限を追加できます。

完了:

```text
/todo done
/todo done id: 3
```

`id` を省略すると未完了todoの候補ボタンが表示されます。

### ガイド

```text
/guide
```

使えるスラッシュコマンドを、ユウカの定型文で表示します。

### リマインダー

`#reminder` に自然文を書きます。

```text
10分後に水を飲む
```

またはスラッシュコマンドでも登録できます。

```text
/reminder add text: 今日15時に電話する
/reminder list
```

`/reminder list` には削除ボタンも表示されます。`#雑談` で `昼ごはんのリマインダー消して` のように書いた場合も、削除候補を確認してから削除できます。

リマインダー時刻ちょうどの通知には、対応済みとスヌーズのボタンが付きます。

日時が読み取れなかったリマインダー候補には `日時を設定` ボタンが出ます。押すと入力欄が開き、`10分後`、`今日22時`、`明日朝` のような自然文で日時を追加できます。

```text
[対応済み]
[5分後] [30分後] [1時間後] [3時間後] [明日]
```

`明日` は翌朝9:00に再通知します。

todo期限時刻ちょうどの通知には、完了確認と再通知ボタンが付きます。

```text
[完了] [まだ終わってない]
```

`まだ終わってない` を押すと、再通知を選べます。期限そのものは変更せず、通知だけをもう一度出します。

```text
[5分後] [30分後] [1時間後]
```

### 雑談

`#雑談` では普通に会話できます。1つの投稿に雑談、todo、リマインダー、完了報告が混ざっていても、Geminiが複数イベントとして分けて処理します。

```text
今日ちょっと疲れた。あと明日19時に駅行かなきゃ。資料も終わった。
```

この場合、必要に応じて以下を分けて処理します。

- 雑談への短い返答
- リマインダー候補
- todo完了確認

支出や浪費っぽい発言も、金額が明確な場合だけ候補として拾います。

```text
本に3000円使った
```

Botは支出候補を提示し、`記録する` を押すとD1に保存します。月末日の12:00に、カテゴリ別の支出レポートを `#報告` に送ります。

支出メモ一覧:

```text
/expense list
/expense list range: month
/expense list range: all
```

`range` を省略すると `all` として、直近全体の支出メモを表示します。合計、カテゴリ別、直近明細10件が出ます。間違って登録した支出メモは、一覧の削除ボタンで削除できます。

### ペルソナ設定

`#設定` に `SOUL.md` のようなMDファイルを添付します。botが読み取ってD1に保存し、雑談や通知のAI一言に反映します。

```text
先生、人格設定を更新しました。
ファイル: hayase_yuuka_SOUL.md
これで私の応答方針は再計算済みです。
```

ターミナルから直接入れる場合は、次も使えます。

```bash
npm run persona:apply -- /path/to/SOUL.md
```

## ユウカの定型文を編集する

`src/yuuka-phrases.ts` は、ユウカの「定型文」をまとめた編集用ファイルです。Discord上で見る固定メッセージ、朝会のリスク警告、過密スケジュール警告、Gemini不調時の案内、バックアップ関連メッセージ、`/guide` の説明文をここで管理しています。

プログラミング初心者でも、`unknownCommand` や `commandGuide` などの文字列を書き換えるだけで表示文を変えられます。`src/index.ts` のロジックは変えず文面だけ変えたい場合は、基本的にこのファイルを編集してください。

主な編集対象:

| キー | 内容 |
|---|---|
| `unknownCommand` | 未対応コマンドを入力した時の返答 |
| `expiredConfirmation` | 確認ボタンが期限切れになった時の返答 |
| `geminiUnavailable` | Gemini APIが一時的に使えない時の返答 |
| `geminiOutageReport` | Gemini不調が30分以上続いた時に `#報告` へ出す通知 |
| `backupStarted` | `/backup` 実行時にバックアップ作成を開始した時の返答 |
| `backupCompleted` | バックアップJSONを `#報告` に送信できた時の返答 |
| `backupFailed` | バックアップ作成に失敗した時の返答 |
| `preNotifyParseError` | 事前通知の入力内容を読み取れなかった時の返答 |
| `preNotifyRequired` | 事前通知モード「毎回」で設定が未選択の場合に出す返答 |
| `riskMessages` | 朝会で出すリスク警告文。期限超過・期限1時間以内・期限24時間以内など条件別の文面。`count` に該当件数が入る |
| `todayLoadWarning` | 今日の予定・todoが6件以上ある時に出す過密スケジュール警告 |
| `hiddenAdultPranks` | 特定入力に対する隠しリアクション文。友人向けの遊び要素なので、一般配布版や販売版には含めない |
| `commandGuide` | `/guide` で表示されるコマンド説明文 |

注意点:

- `riskMessages` や `todayLoadWarning` は関数になっているため、`${count}` や `${total}` のような件数表示を残す必要があります。
- `commandGuide` は配列を `.join("\n")` しているので、行単位で編集できます。
- Discordの1メッセージ文字数制限があるため、長くしすぎないようにしてください。
- ユウカらしさを調整したい時は、SOUL.mdの人格設定だけでなく、この定型文も一緒に調整すると体験が安定します。

## Cronと通知

`wrangler.toml` では1分ごとのCronを1本だけ設定しています。

```text
* * * * *
```

この1本で、自然文チャンネル確認、事前通知、実時間通知、朝会、夜締めを処理します。

事前通知が有効な場合、通知は2回届きます。

1. 事前通知: 例 `15分前`
2. 実時間通知: 予定時刻・期限時刻

Cloudflare Cronの上限は「登録できるCronスケジュールの本数」の話です。このbotは1本のCronがD1内のtodo/reminderを確認するため、todoやリマインダーが5件までに制限されるわけではありません。

## 現状と設計書との差分

実装済み:

- 専用チャンネル運用
- 最終確認つきtodo/reminder登録
- `#雑談` からの複数イベント抽出
- ペルソナMD添付
- 朝会、夜締め
- 事前通知と実時間通知
- リマインダー通知からの対応済み・スヌーズ
- todo期限通知からの完了・再通知
- 支出・浪費メモと月末昼の支出レポート
- 支出メモ一覧
- 期限超過1日目/2日目を分けた反応
- 先延ばしtodoの因数分解提案
- 同じ日に予定/todoが6件以上ある時のレア台詞
- `#つぶやき` AI不介入
- 繰り返しリマインダー
- `/backup` と月次自動バックアップ
- Gemini障害時フォールバック

設計書にあるが未実装:

- 外部カレンダー連携

## 引き渡しメモ

- Gemini APIキーは利用者本人のGoogleアカウントで発行してください。
- Cloudflareアカウント、D1、Workersも利用者本人のアカウントで管理してください。
- Discord Botのアイコン画像はDeveloper Portalからいつでも変更できます。
- Bot所有権の移譲はDiscord Teamを使います。具体的な段取りは `MIGRATION_OWNER_GUIDE.ja.md`（作成者側）と `REMOTE_FRIEND_SETUP_GUIDE.ja.md` フェーズ②・⑥（利用者側）を参照してください。
