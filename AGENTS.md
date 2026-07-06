# Kakeibo Project Rules

このリポジトリを変更する際は、現行仕様の正本である
[`docs/SPECIFICATION.md`](docs/SPECIFICATION.md)を先に確認すること。
ファイル別の責務とデータフローは[`docs/CODEMAP.md`](docs/CODEMAP.md)、
既知の課題と改善方針は[`docs/IMPROVEMENTS.md`](docs/IMPROVEMENTS.md)を参照。

## Required Invariants

- `main`（家庭用）と`yahoo`（個人用）のデータを混在させない。
  - `main`: `Data` / `Config` / `Fixed`
  - `yahoo`: `Yahoo_Data` / `Yahoo_Config` / `Yahoo_Fixed`
- Spreadsheet ID、LINE ID、アクセストークン、実取引情報、パスワードを
  リポジトリ、テスト、ドキュメントへ保存しない。
- GASソースのリポジトリ上の正本は`public/GAS.txt`とする。
- GAS API契約を変更した場合は、`public/GAS.txt`、呼び出し側、テスト、
  `docs/SPECIFICATION.md`を同時に更新する。
- GAS変更を本番へ出すときは、Apps Scriptの新バージョンを先にデプロイし、
  その後にVercelをデプロイする。
- 書き込み処理では、影響するGASキャッシュを必ず無効化する。
- 新規追加または変更する明細1件の更新・削除では、MessageIdだけを一意キーとして信用しない。
  同じメールから複数明細が作られる可能性を考慮し、必要な識別項目を照合する。
- 既存`deleteTransaction`はMessageIdの先頭一致を削除する既知制約がある。
  この処理を変更する場合は、呼び出し契約とGASを同時に厳密照合へ移行する。
- 集計では`Type === "Income"`のみ収入、それ以外は支出として扱う。
  空カテゴリは`未分類`として扱う。

## Change Workflow

1. 関連する実装と`docs/SPECIFICATION.md`を確認する。
2. 挙動変更には回帰テストを追加する。
3. `npm test`、`npm run lint`、`npm run build`を実行する。
4. GAS変更時は`.agents/skills/kakeibo-gas/SKILL.md`の手順に従う。
5. デプロイ前に`git diff`を確認し、秘密情報が含まれていないことを確認する。

## Deployment Boundaries

- `git push`やVercelデプロイは、ユーザーの明示的な承認後に実施する。
- Apps Script本番への貼り付け・新バージョンデプロイはVercelとは別作業である。
- Web UIを先にデプロイすると、新しいGASアクションが未提供で失敗する場合がある。
