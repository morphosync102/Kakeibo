# Kakeibo 現行仕様書

この文書は、現在実装されているKakeiboアプリの仕様と設計の正本です。
将来案ではなく、コードと本番運用が満たすべき現行仕様を記録します。

## 1. システム概要

Kakeiboは、Next.js製Webアプリ、Google Apps Script（GAS）、Google Sheetsで構成される
個人用家計簿です。WebアプリはVercelへ、GASはApps Script Webアプリへ個別にデプロイします。

```text
Browser
  -> Next.js /api/expenses
    -> GAS Web App
      -> Google Sheets
      -> Gmail（カード通知の読取）
      -> LINE Messaging API（月次レポート送信）
```

### データソース

| source | 用途 | 画面ルート | シート接頭辞 |
| --- | --- | --- | --- |
| `main`または未指定 | 家庭用 | `/`, `/calendar`, `/manage` | なし |
| `yahoo` | 個人用 | `/yahoo`, `/yahoo/calendar`, `/yahoo/manage` | `Yahoo_` |

コンポーネント、API、GASの全レイヤーでsource分離を維持します。

## 2. 画面仕様

### 認証

- `/login`で`APP_PASSWORD`と入力値を照合します。
- 成功時はHttpOnly Cookie `kakeibo_session=authenticated`を30日間設定します。
- `middleware.ts`が画面と`/api/expenses`を保護します。

### レポート

- 当月を初期表示し、月カードの横スワイプで表示月を切り替えます。
- 月ごとの収入、支出、収支、カテゴリ別円グラフ、明細履歴を表示します。
- `Type === "Income"`のみ収入、それ以外は支出です。
- 履歴の明細を選ぶと詳細モーダルを表示します。

### 明細詳細

- 選択した明細1件の日付を変更できます。
- 日付変更は`YYYY/MM/DD`のみを扱い、時刻は扱いません。
- カテゴリ変更は同じ店舗名の既存明細を両sourceで更新し、
  Configにも今後の自動分類ルールとして保存します。
- 明細1件を削除できます。

日付変更は同じMessageIdを共有する別明細の誤更新を防ぐため、次をすべて照合します。

- MessageId
- 変更前日付
- 店舗名
- 金額

### カレンダー

- 月単位で移動し、日ごとの収入・支出合計を表示します。
- 選択日の明細一覧を表示し、明細を削除できます。

### 管理

- 収入・支出を手動登録できます。
- 固定費を追加・削除できます。
- 固定費はGASの日次トリガーで、設定日の当月明細として1回だけ追加されます。

## 3. データモデル

Spreadsheet IDはGAS Script Property `SHEET_ID`から取得します。

### Data / Yahoo_Data

| 列 | 名前 | 内容 |
| --- | --- | --- |
| A | Date | `YYYY/MM/DD` |
| B | Merchant | 店舗名・内容 |
| C | Amount | 金額 |
| D | Category | カテゴリ。空の場合は表示・集計時に`未分類` |
| E | MessageId | メールID、固定費ID、手動入力ID |
| F | Timestamp | 登録日時 |
| G | Type | `Income`または`Expense`。空やその他は支出扱い |

MessageIdは常に一意とは限りません。同じメールから複数明細を抽出した場合、
複数行が同じMessageIdを共有します。

### Config / Yahoo_Config

| 列 | 名前 | 内容 |
| --- | --- | --- |
| A | 支払い先 | 自動分類に使う部分一致キーワード |
| B | 分類 | カテゴリ |

### Fixed / Yahoo_Fixed

| 列 | 名前 | 内容 |
| --- | --- | --- |
| A | Type | `Income` / `Expense` |
| B | Name | 明細名 |
| C | Amount | 金額 |
| D | Day | 毎月の登録日 |
| E | Category | カテゴリ |

## 4. API契約

ブラウザは直接GASへアクセスせず、Next.jsの`/api/expenses`を経由します。
Next.jsは`GAS_API_URL`へリクエストを転送します。

### GET

- `GET /api/expenses`: 対象sourceの明細一覧
- `GET /api/expenses?source=yahoo`: 個人用明細一覧
- `GET /api/expenses?action=getFixedCosts[&source=yahoo]`: 固定費一覧

### POST actions

| action | 更新範囲 | 主な入力 |
| --- | --- | --- |
| `addTransaction` | 対象sourceへ明細1件追加 | date, merchant, amount, category, type |
| `deleteTransaction` | 対象sourceでMessageIdが最初に一致した明細1件削除 | id |
| `updateTransactionDate` | 対象sourceの厳密一致明細1件の日付更新 | id, currentDate, merchant, amount, date |
| `updateCategory` | 両sourceの同一店舗カテゴリとConfig更新 | merchant, category |
| `addFixedCost` | 対象sourceへ固定費1件追加 | type, name, amount, day, category |
| `deleteFixedCost` | 対象sourceの固定費1件削除 | id |

GASはJSONで`{ success: true, ... }`または`{ error: "..." }`を返します。
Next.js POSTプロキシは完了後に`expenses`タグを再検証します。

### 既知制約

- `deleteTransaction`はMessageIdのみで先頭一致行を削除します。同一メールから複数明細が
  生成された場合、意図した行を一意に選べない可能性があります。
- 新規の明細1件更新処理ではこの方式を使用せず、`updateTransactionDate`と同様に
  追加項目を照合します。削除処理を改修する場合も厳密照合へ移行します。

## 5. 自動処理

### メール取込

`runEmailExtraction()`がカード通知メールを読み取り、重複MessageIdを除外して追加します。

| 通知元 | 保存先 |
| --- | --- |
| 楽天カード | `Data` |
| Vpass / Olive | `Yahoo_Data` |
| JCBショッピング通知 | `Yahoo_Data` |

### 固定費

`processFixedCosts()`を日次トリガーで実行します。IDは月・名称・sourceから生成し、
同月の重複登録を防ぎます。

### 月次LINEレポート

- トリガー関数: `sendMonthlyKakeiboReports`
- 実行予定: 毎月10日 09:00
- 対象期間: 前月
- 送信先: `LINE_DESTINATION_MAIN` / `LINE_DESTINATION_YAHOO`
- 内容: 収入、支出、収支、前月比、カテゴリ別支出、高額支出トップ5

LINE webhook形式のPOSTは、メール転送や家計簿更新をせず成功応答で無視します。

## 6. キャッシュ

| レイヤー | 方式 | 無効化 |
| --- | --- | --- |
| Browser | source別localStorage | `useExpenses.refresh()`とバックグラウンド取得で更新 |
| Next.js | `expenses`タグ、1時間再検証 | POST完了後に`revalidateTag` |
| GAS | source・data/fixed別Script Cache、6時間 | GAS書き込み成功後に`clearCache(source)` |

書き込み機能を追加する場合、影響する全キャッシュの更新または無効化が必要です。

## 7. 設定と秘密情報

### Vercel環境変数

- `APP_PASSWORD`
- `GAS_API_URL`

### GAS Script Properties

- `SHEET_ID`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_DESTINATION_MAIN`
- `LINE_DESTINATION_YAHOO`

実値はリポジトリ、テスト、ドキュメントへ保存しません。

## 8. テストとデプロイ

### 必須検証

```bash
npm test
npm run lint
npm run build
```

GASの変更には、VM sandboxを使う`test/gas-*.test.mjs`で回帰テストを追加します。
主要UI契約の回帰は`test/*.test.mjs`で確認します。

### デプロイ順序

GAS API契約を変更する場合:

1. `gas/コード.js`の変更をコミットし、`main`へpushする(UI変更とは別コミット)。
2. GitHub Actions(`deploy-gas.yml`)が`clasp push`と既存デプロイIDへの
   `clasp deploy`を自動実行するので、成功を確認する。
3. その後、依存するWebアプリの変更をpushし、Vercel本番へデプロイする。
4. 本番で対象操作を確認する。

GAS変更がないWebのみの変更は、Vercelデプロイだけで完了します。
手元からの緊急デプロイは`npm run gas:push`と`npm run gas:deploy`でも可能です
(要`npx clasp login`と`.clasp.json`)。
