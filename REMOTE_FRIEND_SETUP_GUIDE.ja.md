# Discord秘書Bot セットアップガイド

このガイドは、Discord秘書Botを**あなた自身の名義**で動かすための手順書です。

すでに以下の会員登録は済んでいる前提です。

- Discord
- Discord Developer Portal
- Cloudflare
- Google AI Studio（Gemini API）

通話しながらでも、ひとりでも進められるように書いています。焦らず、上から順番にやれば必ず終わります。

---

## 全体像：これから何をするのか

ひとことで言うとこうです。

> **DiscordサーバーとユウカのBot本体はそのまま引き継ぐ。作り直すのは、Botを動かす「裏側」だけ。**

具体的にはこう分かれます。

- **そのまま引き継ぐもの**：Discordサーバー、ユウカのBotアカウント（Discordの「Team」機能で所有権をあなたに移します）
- **あなた名義で作り直すもの**：Cloudflare Worker（プログラムが動く場所）、Cloudflare D1 Database（データの保存場所）、Gemini APIキー（AIの頭脳）

なぜ裏側を作り直すかというと、壊れた時やキーを変えたい時に、毎回作成者の対応待ちにならないためです。今回はプレゼントだけど、自分でメンテできる状態にするのがゴールです。

作業は6つのフェーズに分かれています。**フェーズ②と⑥は作成者との共同作業**なので、通話などで連絡が取れる状態で進めるのがおすすめです。

| フェーズ | やること | 目安 |
|---|---|---|
| ① 準備 | コードをPCに置いて、ツールを揃える | 15分 |
| ② ユウカを引き継ぐ | Teamで既存Botの所有権をもらい、IDを控える（作成者と共同） | 20分 |
| ③ Cloudflareを構築する | Botの動く場所とデータベースを作る | 30分 |
| ④ DiscordとWorkerをつなぐ | URLを設定し、コマンドと設定を入れる | 15分 |
| ⑤ 動作テスト | 実際に使って全機能を確認する | 15分 |
| ⑥ 引き渡しの仕上げ | 作成者が後片付けし、サーバー所有権をもらう | 10分 |

※フェーズ②でBot Tokenをリセットした時点から、フェーズ⑤が終わるまでユウカは一時停止します。1〜2時間の昼寝だと思ってください。

---

## メモシート：作業中に控えるもの

途中でいろいろな値をコピーします。**メモ帳アプリにこの表を貼っておいて**、出てきたらすぐ書き込むのがおすすめです。

```text
【Discord Developer Portal で取るもの】（フェーズ②でユウカの移管が終わってから取れます）
Application ID:
Public Key:
Bot Token: （※Reset Tokenで新しくしたもの。誰にも見せない）

【Discordアプリで取るもの】
サーバーID:
#todo のチャンネルID:
#reminder のチャンネルID:
#雑談 のチャンネルID:
#報告 のチャンネルID:
#設定 のチャンネルID:
#つぶやき のチャンネルID:
#はじめに のチャンネルID:

【Google AI Studio で取るもの】
Gemini APIキー: （※誰にも見せない）

【Cloudflare で出てくるもの】
D1の database_id:
Worker URL:
```

### ⚠️ 絶対に守ること：秘密の値をDiscordに貼らない

次の3つは**秘密**です。Discordのチャンネルには絶対に貼らないでください。

- Bot Token
- Gemini APIキー
- Cloudflareの認証情報

もし貼ってしまったら、すぐそのキーをリセット（再発行）すれば大丈夫です。

特に間違えやすいのが、後で出てくるこういうコマンドです。

```powershell
$env:DISCORD_BOT_TOKEN = "実際のBot Token"
$env:DISCORD_APPLICATION_ID = "実際のApplication ID"
$env:DISCORD_GUILD_ID = "サーバーID"
npm run register
```

これは**Discordに貼るものではなく、PCのPowerShellに貼るもの**です。ここだけ注意してください。

---

# フェーズ① 準備

**ここでやること：** コードをPCに置き、ターミナルで動かせる状態にする。

## 1-1. 手元に用意するもの

- Windows PC
- Discord・Cloudflare・Google AI Studioにログインできる状態
- このBotのコード一式（zipまたはGitHub）
- 完成済みDiscordサーバーへの管理権限

あると楽なもの：

- VS Codeなどのエディタ
- ChatGPT / Gemini / Claudeなど、詰まった時に聞けるAI

## 1-2. コードをPCに置く

**zipで受け取った場合：** ダウンロード → 解凍 → 分かりやすい場所（例：デスクトップ）に置く。

**GitHubで受け取った場合：** PowerShell（後述）でクローンします。

```powershell
git clone リポジトリURL
```

やり方が分からなければ、AIにこう聞けばOKです。

> GitHubのリポジトリURLからWindowsのPCにコードをcloneしたいです。PowerShellでどのコマンドを打てばいいか、初心者向けに教えてください。

## 1-3. PowerShellでコードのフォルダに移動する

このガイドで「ターミナル」と言ったら、Windows標準の **PowerShell** のことです。

**開き方：** スタートメニューを開いて「powershell」と入力 → 「Windows PowerShell」をクリック。青い（または黒い）文字入力の画面が出ます。

開いたら、コードのフォルダに移動します。デスクトップに置いた場合の例：

```powershell
cd $HOME\Desktop\discord-secretary-bot
```

移動できたか確認します。

```bash
ls
```

`package.json` `src` `scripts` `migrations` `wrangler.toml` あたりが表示されればOKです。

**うまく移動できない時は**、AIにこう聞いてください。

> WindowsのPowerShellで、ダウンロードした discord-secretary-bot フォルダに移動したいです。pwd と ls の結果を貼るので、次に打つ cd コマンドを教えてください。

## 1-4. Node.js依存関係を入れる

コードのフォルダの中で実行します。

```bash
npm install
```

最後に `found 0 vulnerabilities` のような表示が出れば成功です。多少違っても、エラーで止まっていなければ大丈夫。

**「スクリプトの実行が無効になっているため…」と言われたら**、Windowsの初期設定が原因です（故障ではありません）。PowerShellでこの1行を実行してから、やり直してください。

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**「npmが見つからない」と言われたら**、Node.jsが入っていません。公式サイト（nodejs.org）の **LTS版インストーラ**を入れて、PowerShellを開き直せばOKです。分からなければAIにこう聞いてください。

> Windowsで npm コマンドが見つからないと言われました。Discord BotをCloudflare WorkersにデプロイするためにNode.jsを入れたいです。安全で一般的な入れ方を教えてください。

---

# フェーズ② ユウカを引き継ぐ

**ここでやること：** 既存のユウカBot（Discordアプリ）の所有権を、Discordの「Team」機能であなたに移す。**このフェーズは作成者との共同作業**です。手順の頭に【あなた】【作成者】と書いてあるので、自分の番だけ操作してください。

## 2-1. 【2人とも】二段階認証（2FA）をONにする

Teamの利用には二段階認証が必須です。まだの場合は、Discordの **ユーザー設定 → プライバシー・安全 → 二段階認証** から設定してください（スマホの認証アプリを使う方式が一般的です）。

## 2-2. 【あなた】Teamを作る

1. [Discord Developer PortalのTeamsページ](https://discord.com/developers/teams) を開く
2. **New Team** をクリック
3. Team名は自由です（例：`yuuka-team`）

これで、あなたがこのTeamの「オーナー」になります。

## 2-3. 【あなた】作成者をTeamに招待する

Teamの **Members** から、作成者を **Admin** 権限で招待します。

## 2-4. 【作成者】ユウカをTeamへ移管する

作成者が、ユウカのApplicationをこのTeamへ移します。あなたは完了の連絡を待てばOKです。

⚠️ この操作は**一方通行**（Teamから個人所有には戻せません）。Teamのオーナーがあなたになっていることをお互いに確認してから実行してもらいます。

## 2-5. 【あなた】3つの値を控える

移管が終わると、[あなたのDeveloper Portal](https://discord.com/developers/applications) にユウカが表示されます。開いて、メモシートに控えてください。

| 控えるもの | 場所 |
|---|---|
| **Application ID** | General Information ページ |
| **Public Key** | General Information ページ |
| **Bot Token** | Bot ページで **Reset Token** を押し、**新しく発行されたTokenを控える** |

⚠️ Bot Tokenは、必ず **Reset Token** で新しくしてください。古いTokenが無効になり、この瞬間から**ユウカを動かせるのは（新しいTokenを知っている）あなただけ**になります。

Resetした瞬間、ユウカは一時的に眠ります。このガイドを最後まで進めれば復活するので、慌てなくて大丈夫です。

## 2-6. 【あなた】Botの設定を確認する

同じ **Bot** ページで、**MESSAGE CONTENT INTENT** のスイッチが**ONになっていることを確認**します（作成者の設定が引き継がれているはずですが、念のため）。

これがONでないと、Botが `#todo` や `#雑談` に書いた普通の文章を読めません。

## 2-7. 【あなた】サーバーIDとチャンネルIDを控える

ここからはDiscordアプリ側の作業です。まず開発者モードをONにします。

1. Discordの **ユーザー設定** → **詳細設定** → **開発者モード** をON

すると右クリックメニューにIDコピーが出るようになります。

- **サーバーID：** サーバーアイコンを右クリック → 「サーバーIDをコピー」
- **チャンネルID：** 各チャンネルを右クリック → 「チャンネルIDをコピー」

メモシートの8か所（サーバーIDと7つのチャンネルID）を全部埋めてください。後でまとめて使います。

## 2-8. 【あなた】Gemini APIキーを取る

[Google AI Studio](https://aistudio.google.com/) で作業します。

1. **API Key を作成**
2. キーをコピーして、メモシートに控える

無料枠で始められます。使いすぎが心配なら、Google AI Studio の Usage 画面でいつでも確認できます。

**✅ フェーズ②完了チェック：** あなたのDeveloper Portalにユウカが見えていて、メモシートの「Cloudflareで出てくるもの」以外が全部埋まっていればOK。

---

# フェーズ③ Cloudflareを構築する

**ここでやること：** Botのプログラムが動く場所（Worker）とデータの保存場所（D1）を作る。

ここからはターミナル作業が続きます。**必ずコードのフォルダの中で**実行してください（フェーズ①-3参照）。

## 3-1. Cloudflareにログインする

```bash
npx wrangler login
```

ブラウザが開くので、Cloudflareにログインして許可します。ターミナルに完了メッセージが出れば成功です。

ブラウザが開かない場合は、ターミナルに表示されたURLをコピーしてブラウザで開いてください。

## 3-2. D1 Database（保存場所）を作る

```bash
npx wrangler d1 create discord_secretary_bot
```

成功すると、こんな情報が表示されます。

```text
database_name = "discord_secretary_bot"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

この **database_id** をメモシートに控えてください。

## 3-3. wrangler.toml を編集する

コード内の `wrangler.toml` をエディタで開き、この部分を探します。

```toml
[[d1_databases]]
binding = "DB"
database_name = "discord_secretary_bot"
database_id = "..."
```

`database_id` を、さっき控えたIDに差し替えます。

また、`SETTING_CHANNEL_ID` という行がある場合は、`#設定` のチャンネルIDに書き換えます。

```toml
SETTING_CHANNEL_ID = "123456789012345678"
```

**ここはAIに手伝ってもらってOKです。** こう聞くと安全です。

> この wrangler.toml に Cloudflare D1 の database_id と Discordの設定チャンネルIDを入れたいです。今の wrangler.toml と、database_id と、設定チャンネルIDを貼るので、どこを書き換えればいいか教えてください。余計な場所は変えないでください。

## 3-4. 秘密情報をCloudflare Secretsに入れる

秘密の値は `wrangler.toml` に直接書かず、Cloudflare Secretsという金庫に入れます。

次の5つのコマンドを**1つずつ**実行します。それぞれ実行すると入力を求められるので、メモシートから対応する値を貼り付けてEnterを押します。

| コマンド | 貼る値 |
|---|---|
| `npx wrangler secret put DISCORD_PUBLIC_KEY` | Public Key |
| `npx wrangler secret put DISCORD_BOT_TOKEN` | Bot Token（フェーズ②でResetした新しい方） |
| `npx wrangler secret put DISCORD_APPLICATION_ID` | Application ID |
| `npx wrangler secret put GEMINI_API_KEY` | Gemini APIキー |
| `npx wrangler secret put REPORT_CHANNEL_ID` | `#報告` のチャンネルID |

## 3-5. D1にテーブルを作る

```bash
npm run db:remote
```

途中で `About to apply migration(s), continue? (Y/n)` と聞かれたら `y` を入力します。

`0001_schema.sql` などにチェックが付けば成功です。

## 3-6. Workerをデプロイする

いよいよBotのプログラムをCloudflareに送り込みます。

```bash
npm run deploy
```

成功すると、こんなURLが表示されます。

```text
https://discord-secretary-bot.xxxxx.workers.dev
```

これが **Worker URL** です。メモシートに控えてください。

このURLをブラウザで開いて、「Discord Secretary Bot is running.」のような表示が出ればOKです。

**✅ フェーズ③完了チェック：** Worker URLをブラウザで開いて、動作メッセージが表示される。

---

# フェーズ④ DiscordとWorkerをつなぐ

**ここでやること：** Discordに新しいWorkerの場所を教え、コマンドと設定を入れ直す。ユウカはすでにサーバーにいるので、招待の手順はありません。

## 4-1. Interactions Endpoint URL を設定する

Discord Developer Portal に戻り、**General Information** ページを開きます。

**Interactions Endpoint URL** の欄に、さっきのWorker URLを貼って保存します。

Discord側が自動チェックして、問題なければ保存できます。

**保存できない場合**、よくある原因はこれです。

- `DISCORD_PUBLIC_KEY` の値が間違っている（コピーミス）
- Worker URLが間違っている
- まだデプロイできていない
- Cloudflare Secretsが入っていない

AIに聞くならこうです。

> Discord Developer PortalのInteractions Endpoint URLが保存できません。Cloudflare WorkersでDiscord Botを動かしています。Worker URL、wrangler.toml、設定したSecret名、エラー表示を貼るので、原因候補を順番に確認してください。

## 4-2. スラッシュコマンドを登録する

PowerShellで、以下の3か所を自分の値に書き換えてから、4行まとめて貼り付けて実行します。

```powershell
$env:DISCORD_BOT_TOKEN = "実際のBot Token"
$env:DISCORD_APPLICATION_ID = "実際のApplication ID"
$env:DISCORD_GUILD_ID = "サーバーID"
npm run register
```

⚠️ **これはPowerShellに貼るコマンドです。Discordに貼らないでください。**

成功するとコマンド一覧のJSONが表示されます。Discordで `/guide` と打って候補に出ればOKです。

## 4-3. #設定 にチャンネルIDを入れる

ここからはDiscord内の作業です。あなたのD1データベースは新品なので、**以前のユウカで設定済みだった内容も、もう一度入れ直しが必要**です。`#設定` チャンネルに、メモシートの値を使ってこう投稿します。

```text
todo: 123456789012345678
reminder: 123456789012345678
雑談: 123456789012345678
報告: 123456789012345678
つぶやき: 123456789012345678
```

（数字は自分のチャンネルIDに置き換えてください）

Botから「設定を更新しました」のような返事が来ればOKです。

## 4-4. 時刻設定を入れる

続けて `#設定` に投稿します。

```text
朝: 07:00
夜: 22:30
事前通知: 15
事前通知モード: 毎回
```

意味はこうです。

- **朝** — 朝会の時刻
- **夜** — 夜の締めの時刻
- **事前通知** — 予定の何分前に通知するか
- **事前通知モード** — 毎回選ぶか、固定にするか

## 4-5. 人格設定を入れる（任意）

人格設定の `.md` ファイルがあれば、`#設定` に添付します。Botが返事をすればOKです。

ゼロから作りたい場合は、AIにこう頼むといいです。

> Discord秘書Bot用の人格設定.mdを作りたいです。性格、口調、ユーザーの呼び方、通知のテンション、todoを促す時の態度、雑談の距離感を決めたいです。質問形式で作成を手伝って、最終的にそのまま貼れるMarkdownにしてください。

## 4-6. #はじめに に案内文を投稿する（任意）

すでに `#はじめに` に案内文が投稿されている場合、この手順はスキップしてOKです。

Bot本人に案内文を投稿させる場合は、PowerShellで実行します（2か所を自分の値に書き換えてから）。

```powershell
$env:DISCORD_BOT_TOKEN = "実際のBot Token"
$env:DISCORD_WELCOME_CHANNEL_ID = "はじめにのチャンネルID"
npm run welcome:post
```

投稿後、`#はじめに` の送信権限を制限すると案内板として使えます。おすすめは「`@everyone` のメッセージ送信をOFFにして、Botと管理者だけ書き込める」設定です。

---

# フェーズ⑤ 動作テスト

**ここでやること：** 実際に使ってみて、全機能が動くことを確認する。

※あなたのデータベースは新品なので、以前のユウカに登録していたtodoや支出データは入っていません。まっさらからのスタートです（過去データが必要な場合は、作成者がバックアップから復元できます）。

上から順に試して、チェックを付けていってください。

- ☐ **スラッシュコマンド** — `/guide` と入力 → 使い方が表示される
- ☐ **todo登録** — `#todo` に「明日の18時までに資料を作る」と投稿 → 確認が出るので「確定」を押す → `/todo list` に載っている
- ☐ **リマインダー** — `#reminder` に「10分後に水を飲む」と投稿 →「確定」を押す → 時間になったら `#報告` に通知が来る
- ☐ **雑談** — `#雑談` に「今日ちょっと疲れた」と投稿 → 返事が来る
- ☐ **雑談からtodo** — `#雑談` に「明日の昼までに買い物リスト作らなきゃ」と投稿 → todo候補が出る
- ☐ **支出メモ** — `#雑談` に「本に3000円使った」と投稿 → 支出候補が出る → 記録後 `/expense list` に載っている
- ☐ **設定変更** — `#設定` に「夜: 22:45」と投稿 → 設定更新の返事が来る

## Botが反応しない時のチェックリスト

上から順に確認してください。

1. **Botがサーバーにいるか** — メンバー一覧にBotがいる？
2. **チャンネル権限があるか** — Botに View Channels / Send Messages / Read Message History の権限がある？
3. **MESSAGE CONTENT INTENT がONか** — Developer Portal の Bot ページで確認（フェーズ②-6）
4. **#設定 にチャンネルIDを入れたか** — これがないとBotは `#todo` や `#雑談` を巡回できない（フェーズ④-3）
5. **Workerが動いているか** — Worker URLをブラウザで開いて確認
6. **Secretsが入っているか** — CloudflareのWorker設定画面で確認
7. **1分待ったか** — このBotは1分ごとに巡回するので、投稿直後は最大1分待つ

## よくあるエラーと対処

**「このシステムではスクリプトの実行が無効になっているため、npm.ps1 を読み込むことができません」**

Windowsの初期設定で、PowerShellのスクリプト実行が止められています。初めてnpmを使う人が最初に踏む定番のエラーで、故障ではありません。PowerShellでこの1行を実行してから、元のコマンドをやり直してください。

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

意味は「自分のユーザーだけ、署名付きスクリプトの実行を許可する」で、一般的で安全な設定です。一度実行すれば、次からは出ません。

**`npm error ENOENT package.json`**

コードのフォルダに移動していません。`cd` でフォルダに入り、`ls` で `package.json` が見える場所でコマンドを実行してください。

**`Cannot convert argument to a ByteString`**

環境変数に「Bot Tokenをここに入れる」のような日本語の仮テキストが残っています。実際のTokenに置き換えてください。

**Interactions Endpoint URL が保存できない**

Public Keyの間違い / Worker URLの間違い / Secretの入れ忘れ / デプロイ未完了、のどれかです（フェーズ④-1参照）。

**コマンドがDiscordに出ない**

`npm run register` をもう一度実行してください（フェーズ④-2参照）。

**自然文に反応しない**

MESSAGE CONTENT INTENT がOFF / チャンネルID未設定 / Botの閲覧権限なし / まだ1分経っていない、のどれかです。

---

# フェーズ⑥ 引き渡しの仕上げ

**ここでやること：** 作成者側の後片付けを確認し、サーバーの所有権をもらって完了。ここも作成者との共同作業です。

## 6-1. 【作成者】旧Workerの削除とTeam退出

作成者が、自分のCloudflareに残っている旧Workerを削除し、DiscordのTeamから退出します。あなたは完了の連絡を待つだけでOKです。

これで、ユウカの裏側は完全にあなただけのものになります。

⚠️ 以前のユウカが出した確認ボタンは、新しいWorkerでは動きません。残っているボタンは無視して、必要ならもう一度書けばOKです。

## 6-2. 【2人で】サーバー所有権を受け取る

最後に、Discordサーバーの所有権を作成者からあなたへ移します（作成者がサーバー設定から実行し、あなたが承認します）。

**譲渡前の最終チェック：**

- ☐ フェーズ⑤のテストが全部通った
- ☐ Bot TokenはReset済みで、あなたしか知らない
- ☐ あなたがCloudflareにログインできる
- ☐ あなたのDeveloper Portalでユウカを管理できる
- ☐ あなたがGemini APIキーを管理できる
- ☐ 作成者がTeamから退出した

## 6-3. 完了！

ここまで終われば、サーバーは完成品として渡っていて、裏側のインフラも全部あなたが管理できる状態です。

**引き渡し後、困った時に見る場所：**

- Discordの `#はじめに` と `/guide` — 日常の使い方
- `USER_GUIDE.ja.md` — 詳しい使い方の説明
- Cloudflare Workers / D1 の管理画面 — Botの稼働状況とデータ
- Google AI Studio — Gemini APIの使用量
- Discord Developer Portal — Botの設定

---

# 付録：AIへの聞き方

このガイドの各所で「AIに聞いてください」と書いてきました。詰まったら遠慮なくAIに頼ってOKです。

**AIに聞いていいこと：**

- ターミナルのエラー解読
- `wrangler.toml` のどこを編集するか
- Discord Developer Portal / Cloudflare のどこを見るか
- npmやNode.jsのエラー

**ただし1つだけルール：** Bot Token・Gemini APIキー・Public Keyなどの秘密の値は、AIにも貼らないこと。エラー文は隠さず、秘密情報だけ伏せる、が鉄則です。

**困った時のコピペ用テンプレ：**

```text
私はDiscord秘書BotをCloudflare Workersで動かそうとしています。
使っているものは、Discord Developer Portal、Cloudflare Workers、Cloudflare D1、Gemini API、Node.js、wranglerです。

今やりたいこと:
（ここに目的を書く）

今いる手順:
（ここにフェーズ番号を書く 例: フェーズ③-4）

実行したコマンド:
（ここにコマンドを書く）

出たエラー:
（ここにエラーを書く）

※Bot Token、Gemini API Key、Public Keyなどの秘密情報は貼っていません。

初心者向けに、次に確認することを順番に教えてください。
```

---

## 最後に

このBotは、毎日の予定・todo・リマインダー・支出・生活リズムをDiscordの中でまとめて扱うための秘書サーバーです。

最初は設定が多く感じるかもしれませんが、一度つながってしまえば日常の操作はとても簡単です。

分からないところは、エラー文を隠さず（でも秘密情報は隠して）、AIや作成者に聞いてください。焦らず、1フェーズずつ進めれば大丈夫です。
