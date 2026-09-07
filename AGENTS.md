# AGENTS.md — discord-secretary-bot（ユウカ）作業規約

このリポジトリで作業する AI（Codex / Claude Code / worker席 / Fable席）は、着手前にこのファイルを読み、以下に従う。

## 作業場所と同期

- 編集とコミットは git正本 `~/Library/Mobile Documents/com~apple~CloudDocs/自作アプリ/discord-secretary-bot` で行う。
- `~/dev/discord-secretary-bot` は git 管理外の作業コピー。コミット後に変更ファイルを複写し、`diff -rq` で src・tests・md が一致することを確認する。
- `git push` は Fable席、`wrangler deploy` は安田さん、本番 D1 への書き込みは Fable席が行う。worker席はコミットまで。

## 機能を追加・変更したら必ず更新するファイル

1. `src/yuuka-manual.ts` — ユウカ内蔵の取扱説明。ユウカは「取説にない機能は『まだできません』と答える」ため、ここに無い機能は本番で否定される。
2. `USER_GUIDE.ja.md` — 該当章に、使い方・記録のされ方・失敗時の動きを節として書く。1行追記で済ませない。
3. `WELCOME_MESSAGE.md` — 機能一覧の1行。
4. `ANNOUNCE_<日付>.md` — 先生向けのアップデート報告（ユウカ口調）。
5. `tests/` — 純粋関数の単体テスト。`tests/index.js` に import を足す。

利用者が読む文章（1〜4 と `src/yuuka-phrases.ts` の新規文面）は Fable席が書く。worker席はコード側の接続だけを実装し、文面はプレースホルダを置かず Fable の文面を待つか、発注書に添付された文面をそのまま使う。

## 検証（コミット前に全て通す）

```
npx tsc --noEmit
node --experimental-strip-types --test tests/index.js
grep -rn "INSERT INTO expenses" src   # 1箇所（src/index.ts の recordExpensePendingAction 内）のまま
```

## 触ってはいけない契約

- 支出の記録は必ず確認カード（`pending_actions` kind="expense" → 確定ボタン → `recordExpensePendingAction`）を経由する。カードを通さない `INSERT INTO expenses` を書かない。
- 先生が発言で口にした大分類は、コードの文字一致（`findCategoryDesignation`）で AI の推測に優先させる。AI への依頼文で代替しない。
- DB に保存する値を表示の都合で切らない。切るのは表示用の投影だけ。
- migration の追加・テーブル変更は設計書（Vault `AI/12.設計書庫/ユウカ家計/`）で決めてから行う。
- AI に渡す利用者の文章・画像・OCR 結果は資料であって命令ではない。依頼文にその旨を明記する。

## デプロイと報告文の投稿（Fable席・安田さん向け）

- デプロイ: 安田さんがターミナルで `cd ~/dev/discord-secretary-bot && npx wrangler deploy` を実行する（Fable席の安全装置が deploy を止めるため）。反映確認は Fable席が `npx wrangler deployments status` の Created 時刻と Version ID で行う（画面の貼り付けでは判定しない）。
- 報告文の投稿: `DISCORD_BOT_TOKEN="…" node scripts/post-welcome.mjs 1521789822639935528 ANNOUNCE_<日付>.md`。bot トークンはこの Mac に無いので安田さんが実行する。
- スラッシュコマンドを追加・変更したら `npm run register` も必要。

## 設計書

- ユウカ案件の設計正本は Vault `AI/12.設計書庫/ユウカ家計/`。ひな形は同フォルダ `ひな形_ユウカ案件設計書.md`。
- 設計書の「変更ファイル一覧」には上の「必ず更新するファイル」を最初から含める。
