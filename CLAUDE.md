# CLAUDE.md

Next.js + Google Apps Script (GAS) + Google Sheets で構成された個人用家計簿アプリ。
Webアプリは Vercel、GAS は Apps Script Web アプリへ個別にデプロイする。

```text
Browser
  -> Next.js /api/expenses (プロキシ + 1hタグキャッシュ)
    -> GAS Web App (6h Script Cache)
      -> Google Sheets (Data / Config / Fixed, Yahoo_*)
      -> Gmail (カード通知メールの自動取込)
      -> LINE Messaging API (月次レポート)
```

## 必読ドキュメント

作業前に必ず以下を確認すること。内容の正本はこれらであり、このファイルには要約のみを置く。

| ドキュメント | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | **不変条件と変更ワークフロー(最重要)** |
| [docs/SPECIFICATION.md](docs/SPECIFICATION.md) | 現行仕様と設計の正本(画面・データモデル・API契約・キャッシュ) |
| [docs/CODEMAP.md](docs/CODEMAP.md) | ファイル別責務・データフロー・画面×編集操作の対応表 |
| [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) | 優先度付き改善バックログ(既知の課題と対応方針) |
| [.agents/skills/kakeibo-gas/SKILL.md](.agents/skills/kakeibo-gas/SKILL.md) | GAS(`gas/コード.js`)変更時の必須手順 |

## コマンド

```bash
npm run dev    # 開発サーバー
npm test       # node --test (test/*.test.mjs)
npm run lint   # eslint
npm run build  # next build
```

挙動を変更したら `npm test`・`npm run lint`・`npm run build` を全て実行する。

## 不変条件の要約(詳細は AGENTS.md)

- `main`(家庭用: `Data`/`Config`/`Fixed`)と `yahoo`(個人用: `Yahoo_*`)のデータを混在させない。
- Spreadsheet ID・LINE ID・アクセストークン・実取引情報・パスワードをリポジトリに保存しない。
- GAS ソースの正本は `gas/コード.js`(clasp で本番と同期)。GAS API 契約の変更は
  `gas/コード.js`・呼び出し側・テスト・`docs/SPECIFICATION.md` を同時に更新する。
- デプロイ順序: GAS 変更のコミットを先に push(GitHub Actions が自動デプロイ)→
  成功確認後に UI 変更を push(Vercel)。
- 書き込み処理では影響する GAS キャッシュ(`clearCache`)と Next.js の `expenses` タグを必ず無効化する。
- 明細1件の更新・削除で MessageId を唯一のキーとして信用しない(同一メールから複数明細が生成される)。
  `updateTransactionDate` と同様に日付・店舗名・金額も照合する。
- 集計は `Type === "Income"` のみ収入、それ以外は支出。空カテゴリは `未分類`。
- `git push`・Vercel デプロイ・Apps Script デプロイはユーザーの明示的な承認後に実施する。
