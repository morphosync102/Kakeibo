# コードマップ

ファイル別の責務と、変更時に把握すべきデータフローをまとめる。
仕様の正本は [SPECIFICATION.md](SPECIFICATION.md)、不変条件は [../AGENTS.md](../AGENTS.md) を参照。

## ディレクトリ構成と責務

### app/ (ルーティング — 全ページは共有コンポーネントの薄いラッパー)

| パス | 内容 |
| --- | --- |
| `app/page.tsx` | `/` 家庭用ダッシュボード → `Dashboard`(source未指定) |
| `app/calendar/page.tsx` | `/calendar` 家庭用カレンダー → `CalendarView` |
| `app/statistics/page.tsx` / `app/yahoo/statistics/page.tsx` | 家庭用・個人用の全期間統計 → `StatisticsView` |
| `app/manage/page.tsx` | `/manage` 家庭用の手動入力・固定費 → `ManageView` |
| `app/yahoo/page.tsx` ほか `yahoo/` 配下 | 個人用。同じコンポーネントに `source="yahoo"` `isDarkMode` を渡すだけ |
| `app/yahoo/layout.tsx` | 個人用のメタデータ・ダーク背景(`BodyBackgroundSetter`) |
| `app/login/page.tsx` | パスワード認証画面 |
| `app/api/expenses/route.ts` | **GASへの唯一のプロキシ**。GET・POSTとも署名付きセッションを独立検証してからGASに接続。GETはタグキャッシュ、POSTは透過転送＋関連タグ無効化 |
| `app/api/auth/verify/route.ts` | `APP_PASSWORD` 照合、署名付き`kakeibo_session` Cookie(30日)発行。署名鍵未設定時は拒否 |

### components/

| ファイル | 責務 | 使用ページ |
| --- | --- | --- |
| `Dashboard.tsx` | 月カード横スワイプ、円グラフ、カテゴリ絞り込み、明細リスト。明細タップで `ExpenseDetailModal` を開く | `/`, `/yahoo` |
| `ExpenseDetailModal.tsx` | **明細編集の中心**。日付・金額・カテゴリ変更と厳密照合削除。body直下Portal、背景スクロール固定、画面高・セーフエリア対応。破壊的操作は2タップ確認 | Dashboard / CalendarView（検索結果を含む） |
| `CalendarView.tsx` | 月カレンダー + 日別明細。明細タップで `ExpenseDetailModal` を開く。日別集計は `useMemo` の Map に前計算 | `/calendar`, `/yahoo/calendar` |
| `ExpenseSearch.tsx` | 独立した検索条件・50件単位の表示上限を保持し、支出の絞り込み・件数・合計・結果一覧を表示。選択明細は親の共有モーダルへ渡す | CalendarView |
| `StatisticsView.tsx` | 全期間／年／月の収支集計・複合グラフ・累積折れ線・カテゴリ別支出・年別カテゴリ表・集計表。source別取得、失敗時の再取得 | `/statistics`, `/yahoo/statistics` |
| `ManageView.tsx` | 手動入力(`addTransaction`)と固定費 CRUD(`addFixedCost`/`deleteFixedCost`)。明細一覧は表示しない | `/manage`, `/yahoo/manage` |
| `BottomNav.tsx` | 下部ナビゲーション | 全画面 |
| `BodyBackgroundSetter.tsx` | body 背景色の設定 | yahoo layout |

### その他

| ファイル | 責務 |
| --- | --- |
| `hooks/useExpenses.ts` | 明細取得フック。localStorage キャッシュ(source別キー)を即表示 → バックグラウンドで再取得。`refresh()` で明示更新、`removeLocal()` / `updateLocal()` で楽観的更新、`error` で失敗通知(失敗時もキャッシュ維持) |
| `lib/api.ts` | `Expense` 型と `fetchExpenses()`(`/api/expenses` を叩き日付降順ソート。エラー時は throw) |
| `lib/categories.ts` | 支出・収入カテゴリ定数の正本(全コンポーネントがここから import) |
| `lib/expense-analysis.ts` | 純粋関数：日付の厳密な正規化、期間集計・ゼロ補完・累積値、支出検索条件の検証・AND絞り込み・合計、カテゴリ候補 |
| `middleware.ts` | セッションの署名・期限による画面・API保護。無効な場合、APIは401、画面は`/login?returnTo=`へ |
| `lib/session.ts` | サーバー用Web Crypto HMAC-SHA256によるセッション発行・署名／期限／形式検証。乱数nonceと環境変数`SESSION_SECRET`を使用 |
| `gas/コード.js` | **GAS ソースの正本**(約900行、clasp で本番と同期)。変更時は `.agents/skills/kakeibo-gas/SKILL.md` の手順に従う |
| `gas/appsscript.json` | GAS マニフェスト(タイムゾーン・Web アプリ設定) |
| `.github/workflows/deploy-gas.yml` | main への push(`gas/**` 変更時)で clasp push + 既存デプロイ ID へ deploy |
| `test/*.test.mjs` | `node --test`。`gas-*.test.mjs` は VM sandbox で `gas/コード.js` を評価して回帰テスト |
| `test/statistics-search.browser.mjs` | `npm run test:e2e`。架空APIによる両source・期間切替・検索・編集削除・レスポンシブなモーダル操作のブラウザー回帰 |
| `test/session.test.mjs` / `test/auth-routes.test.mjs` | セッション改ざん・期限・鍵の検証、Middlewareを経由しないAPIハンドラーの認証、ログインCookie属性の回帰 |
| `test/auth.browser.mjs` | 本番ビルドを一時起動し、毎回生成した認証情報と架空GASで認証・既存機能E2Eを実行するハーネス。実サービスへ接続しない |

## データフロー(3層キャッシュ)

```text
useExpenses (localStorage, source別)   ← 即表示 + マウント時バックグラウンド再取得
  → GET /api/expenses (Next.js fetch cache, 1h, tags: ['expenses'])
    → GAS doGet (Script Cache, 6h, source×data/fixed別キー)
      → SpreadsheetApp

書き込み: POST /api/expenses → GAS doPost → シート更新 + clearCache(source)
          → Next.js 側で revalidateTag('expenses') → クライアントは onUpdate/refresh() で再取得
```

書き込み系を追加・変更する場合、**3層すべての無効化経路**を確認すること。
固定費は `fixedCosts` タグで別管理(GET でタグ付与、`addFixedCost` / `deleteFixedCost` の POST 後に revalidate)。

## 画面 × 明細編集操作の対応表(現状)

| 画面 | 削除 | 日付変更 | カテゴリ変更 | 金額変更 |
| --- | --- | --- | --- | --- |
| ダッシュボード(明細タップ→モーダル) | ✓ | ✓ | ✓(1件のみ / 店舗一括を選択式) | ✓ |
| カレンダー(明細タップ→同じモーダル) | ✓ | ✓ | ✓(同上) | ✓ |
| 支出検索(結果タップ→同じモーダル) | ✓ | ✓ | ✓(同上) | ✓ |
| 管理 | -(明細一覧なし) | - | - | - |

明細が見える全画面で同じ `ExpenseDetailModal` を使う。新しい編集操作を追加する場合もこのモーダルに集約する。

## gas/コード.js 関数マップ

| 領域 | 主な関数 |
| --- | --- |
| エントリ | `doGet`(既定: 明細一覧 / `getFixedCosts`)、`doPost`(action分岐)、`responseJSON` |
| キャッシュ | `getCacheKey`、`clearCache(source)`、`getExpensesWithCache`、`getFixedCostsWithCache` |
| 書き込みaction | `addTransaction` / `deleteTransaction`(date/merchant/amount指定で厳密照合、idのみは旧互換の先頭一致)/ `updateTransactionDate`(厳密照合)/ `updateTransaction`(厳密照合で金額・店舗名・カテゴリ更新)/ `updateCategory` / `addFixedCost` / `deleteFixedCost` |
| メール取込 | `runEmailExtraction` → `extractRakutenEmails` / `extractOliveEmails` / `extractJcbEmails` + 各 `parse*Body`、`determineCategory`、`getExistingMessageIds` |
| 固定費 | `processFixedCosts`(日次トリガー)→ `processFixedCostsForSource` |
| 月次LINEレポート | `sendMonthlyKakeiboReports`(毎月10日トリガー)→ `sendMonthlyKakeiboReportForSource`、`buildMonthlyKakeiboReportText`、`pushLineTextMessage`、`testSend*` 各種 |
| その他 | `getTargetSheets(source)`(main/yahoo分離の要)、`isLineWebhookPayload`(webhook無視) |

## カテゴリ定数の所在

編集・登録用カテゴリは`lib/categories.ts`に集約。検索候補は対象sourceの登録済み支出から生成する。
