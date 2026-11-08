# コードマップ

ファイル別の責務と、変更時に把握すべきデータフローをまとめる。
仕様の正本は [SPECIFICATION.md](SPECIFICATION.md)、不変条件は [../AGENTS.md](../AGENTS.md) を参照。

## ディレクトリ構成と責務

### app/ (ルーティング — 全ページは共有コンポーネントの薄いラッパー)

| パス | 内容 |
| --- | --- |
| `app/page.tsx` | `/` 家庭用ダッシュボード → `Dashboard source="main"` |
| `app/calendar/page.tsx` | `/calendar` 家庭用カレンダー → `CalendarView source="main"` |
| `app/statistics/page.tsx` / `app/yahoo/statistics/page.tsx` / `app/yuki/statistics/page.tsx` | 全期間統計 → `StatisticsView` |
| `app/manage/page.tsx` | `/manage` 家庭用の手動入力・固定費 → `ManageView source="main"` |
| `app/yahoo/page.tsx` ほか `yahoo/` 配下 | 個人用。同じコンポーネントに `source="yahoo"` を渡すだけ(ダーク配色はレジストリから) |
| `app/yahoo/layout.tsx` | 個人用のメタデータ・ダーク背景(`BodyBackgroundSetter`) |
| `app/yuki/page.tsx` ほか `yuki/` 配下 | Yuki 用。同じコンポーネントに `source="yuki"` を渡すだけ |
| `app/yuki/layout.tsx` | Yuki 用のメタデータ(`/yuki-manifest.json`)・淡いピンクの背景と themeColor(レジストリの値) |
| `app/login/page.tsx` | パスワード認証画面 |
| `app/api/expenses/route.ts` | **GASへの唯一のプロキシ**。GET・POSTとも署名付きセッションを独立検証してからGASに接続。GET・POSTとも source を検証(不正は400)。GETは `unstable_cache`(タグ別5分、配列以外は502でキャッシュしない。`fresh=1` は迂回して GAS を直接読む)、`maxDuration = 60`、POSTは透過転送＋関連タグ無効化 |
| `app/api/auth/verify/route.ts` | `APP_PASSWORD` 照合、署名付き`kakeibo_session` Cookie(30日)発行。署名鍵未設定時は拒否 |

### components/

| ファイル | 責務 | 使用ページ |
| --- | --- | --- |
| `Dashboard.tsx` | 月カード横スワイプ、円グラフ、カテゴリ絞り込み、明細リスト。明細タップで `ExpenseDetailModal` を開く。見出しはレジストリの `dashboardTitle` | `/`, `/yahoo`, `/yuki` |
| `ExpenseDetailModal.tsx` | **明細編集の中心**。日付・金額・カテゴリ変更と厳密照合削除。body直下Portal、背景スクロール固定、画面高・セーフエリア対応。破壊的操作は2タップ確認 | Dashboard / CalendarView（検索結果を含む） |
| `CalendarView.tsx` | 月カレンダー + 日別明細。明細タップで `ExpenseDetailModal` を開く。日別集計は `useMemo` の Map に前計算 | `/calendar`, `/yahoo/calendar` |
| `ExpenseSearch.tsx` | 独立した検索条件・50件単位の表示上限を保持し、支出の絞り込み・件数・合計・結果一覧を表示。選択明細は親の共有モーダルへ渡す | CalendarView |
| `StatisticsView.tsx` | 全期間／年／月の収支集計・複合グラフ・累積折れ線・カテゴリ別支出・年別カテゴリ表・集計表。source別取得、失敗時の再取得 | `/statistics`, `/yahoo/statistics` |
| `ManageView.tsx` | 手動入力(`addTransaction`)と固定費 CRUD(`addFixedCost`/`deleteFixedCost`)。明細一覧は表示しない | `/manage`, `/yahoo/manage` |
| `BottomNav.tsx` | 下部ナビゲーション。パスから `sourceFromPathname` で source を決め、`sourceHref` で同じ source のタブへリンク | 全画面 |
| `BodyBackgroundSetter.tsx` | body 背景色の設定 | yahoo / yuki layout |

全 View(Dashboard / CalendarView / StatisticsView / ManageView)は `source: SourceId` が必須で、`getSource(source).theme` からダーク配色の有無とアクセント(`ACCENT_CLASSES`)を決める。`ExpenseDetailModal` も `source` 必須。

### その他

| ファイル | 責務 |
| --- | --- |
| `hooks/useExpenses.ts` | 明細取得フック(`useExpenses(source)`、source 必須)。localStorage キャッシュ(source別キー。main は従来の `kakeibo_expenses_cache` のまま)を即表示 → バックグラウンドで再取得。`refresh()` で明示更新、`removeLocal()` / `updateLocal()` で楽観的更新(対象行は `isSameExpense` で特定。未完了の書き込み中・取得開始後の変更があった取得結果は破棄し、書き込み完了後に再取得)、`error` で失敗通知(失敗時もキャッシュ維持) |
| `lib/api.ts` | `Expense` 型と `fetchExpenses(source, { fresh })`(source 必須で常に送る。`/api/expenses` を叩き日付降順ソート。`fresh` でサーバーキャッシュ迂回。エラー時は throw) |
| `lib/sources.ts` | UI の source レジストリ(`SOURCES` / `SOURCE_IDS`: id・ラベル・basePath・見出し・テーマ)、`isSourceId`、`getSource`(未知は例外)、`sourceFromPathname`、`sourceHref`。GAS の `SOURCES` と id・順序・ラベルが一致(テストで検査) |
| `lib/theme.ts` | accent(`indigo` / `pink`)ごとのクラス対応表 `ACCENT_CLASSES`(完全なクラス名のみ。indigo は従来のクラスそのまま)と `pickMode` |
| `lib/categories.ts` | 支出・収入カテゴリ定数の正本(全コンポーネントがここから import) |
| `lib/expense-analysis.ts` | 純粋関数：日付の厳密な正規化、期間集計・ゼロ補完・累積値、支出検索条件の検証・AND絞り込み・合計、カテゴリ候補 |
| `middleware.ts` | セッションの署名・期限による画面・API保護。無効な場合、APIは401、画面は`/login?returnTo=`へ |
| `lib/expense-identity.ts` | `isSameExpense()`: 両方に `rowId` があれば rowId 比較、なければ MessageId+日付+店舗+金額の従来比較(旧 localStorage キャッシュ互換) |
| `lib/expenses-proxy.ts` | プロキシ用の純粋関数: `isAllowedSource()`(省略/main/yahoo/yuki。レジストリと一致をテストで検査)、`parseGasList()`(配列以外は例外) |
| `lib/session.ts` | サーバー用Web Crypto HMAC-SHA256によるセッション発行・署名／期限／形式検証。乱数nonceと環境変数`SESSION_SECRET`を使用 |
| `lib/write-queue.ts` | クライアント書き込みの直列化。`postWrite()` が `/api/expenses` への POST(`keepalive`、45秒タイムアウト。時間切れは失敗確定ではない `WriteTimeoutError`)を1本の Promise チェーンで順に送る(失敗・時間切れでも次を送る)。未完了数の購読/取得と完了数、取得結果を適用してよいかの判定 `shouldApplyFetch()`、破棄後の動作 `fetchDiscardAction()` |
| `gas/コード.js` | **GAS ソースの正本**(約900行、clasp で本番と同期)。変更時は `.agents/skills/kakeibo-gas/SKILL.md` の手順に従う |
| `gas/appsscript.json` | GAS マニフェスト(タイムゾーン・Web アプリ設定) |
| `.github/workflows/deploy.yml` | main への push で test → GAS(稼働中ビルドから `gas/` に差分がある時のみ。`GAS_BUILD` に SHA を埋めて clasp push/deploy → `?action=version` で確認)→ Vercel(prebuilt)本番デプロイ(承認者なし、push が承認ゲート) |
| `scripts/gas-build.mjs` | 稼働中 GAS の `?action=version` を問い合わせてビルド SHA だけを出力(応答本文・key は出さない) |
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
| エントリ | `doGet`(既定: 明細一覧 / `getFixedCosts`)、`doPost`(action分岐。`handleWriteAction(params, source, actor)`)、`responseJSON` |
| キャッシュ | `getCacheKey`、`clearCache(source)`、`getExpensesWithCache`、`getFixedCostsWithCache` |
| 書き込みaction | `addTransaction`(RowId採番)/ `deleteTransaction`(date/merchant/amount指定で厳密照合、idのみは旧互換の先頭一致、rowId があれば優先)/ `updateTransactionDate`(厳密照合、rowId 優先)/ `updateTransaction`(厳密照合で金額・店舗名・カテゴリ更新、rowId 優先)/ `updateCategory` / `addFixedCost` / `deleteFixedCost` |
| メール取込 | `runEmailExtraction` → `extractRakutenEmails` / `extractOliveEmails` / `extractJcbEmails` + 各 `parse*Body`、`determineCategory`、`getExistingMessageIds` |
| sourceレジストリ | `SOURCES` / `SOURCE_IDS`(main・yahoo・yuki のシート名・ラベル・LINE宛先Property・`lineOptional`・`requiresActor`)、`normalizeSource`(Web App入力。省略=main は旧クライアント互換)、`getSourceConfig` / `getTargetSheets(source)`(未知・省略は例外。main への落ち込み無し)、`runForEachSource`(source ごとの try/catch ループ)、`setupSourceSheets`(エディタ実行、冪等)、`CATEGORY_GROUPS` + `getCategoryUpdateSources`(updateCategory の対象 = グループ ∩ actor の sources) |
| actor照合 | `authorizeDataRequest`(doGet/doPost で key・source 検証の後。`readActorParams` / `parseEpoch`、`AUTHZ_ENFORCE` は `isAuthzEnforced`、actor フィールドがあれば `authKey` 必須 `hasActorFields` + `isAuthProxyRequest`(`AUTH_PROXY_SECRET` と定数時間比較))、`getAuthUsers`(世代付き Script Cache → `Auth_Users` シート、`parseAuthUsers` は見出し名で列特定・複数行の userId は形式不正の行を含め無効)、`clearAuthUsersCache`(flush → 世代切替。Auth_Users 書き込み後にロック内で・手編集後に実行) |
| 認証API | `doPost` が `AUTH_ACTIONS` を source 検証より前に `handleAuthAction` へ分岐(`key` に加えて `authKey` 必須 = `isAuthProxyRequest`、未設定・不一致は全拒否、例外は `AuthError`。`warnAboutAuthProxySecret` は setup 時の警告)。`authGetAdminUser` / `authPeekInvite` / `authConsumeInviteAndAddCredential` / `authAddCredential` / `authGetCredential` / `authRecordCredentialUse` / `authListCredentials` / `authRevokeCredential` / `authBumpEpoch`。書き込みは `runAuthWrite`(Script Lock、Busy)。共通: `readAuthTable`(見出し名で列特定)、`loadAuthUsers` / `loadAuthCredentials` / `loadAuthInvites`、`findUsableInvite`、`recordChallengeOnce`(Script Cache 5分)、`validateCredentialInput` / `validateSheetText`(数式インジェクション拒否)、`toSheetBase64Url`(`b64u:` 接頭辞)、`newRandomBytes`(UUID×4+時刻+Math.random の SHA-256)/ `newRandomToken` / `newOpaqueId` / `sha256Hex` |
| 認証エディタ関数 | `setupAuthSheets`、`addUser`、`disableUser`、`bumpEpoch`、`createInvite`(URL は実行ログのみ、`APP_ORIGIN` 必須)、`revokeCredential`、`listUsers`、引数なしラッパー `addYukiUser` / `createYukiRegisterInvite` / `createYukiRecoveryInvite` / `createAdminRecoveryInvite` / `bumpAdminEpoch`(`runAuthEditorTask` でロック、`resolveAuthUser` は userId または表示名)。`setupAuthSheets` は `Auth_LineLinks` も作る |
| LINE連携 | `authCreateLineLinkCode`(`newLineLinkCode`、本人の `lineOptional` source のみ `getLinkableSources`、1人1つ)/ `authLinkLine`(LINE userId ごとの失敗3回ブロック・5回/10分・全体20回/10分 `readRecentTimestamps`、候補は Script Cache)/ `authGetLineLinkCandidate`(`fetchLineDisplayName` でプロフィールAPI)/ `authConfirmLineLink`(確定時に source を再確認して宛先 Property を設定、確認 push)。`loadAuthLineLinks`、`findActiveLink` |
| 固定費 | `processFixedCosts`(日次トリガー、レジストリ全件)→ `processFixedCostsForSource(source)`(source 必須) |
| 月次LINEレポート | `sendMonthlyKakeiboReports`(毎月10日トリガー、レジストリ全件、宛先未設定は `lineOptional` の yuki のみスキップ・main/yahoo は失敗)→ `sendMonthlyKakeiboReportForSource`、`buildMonthlyKakeiboReportText`、`pushLineTextMessage`、`testSend*` 各種 |
| RowId(H列) | `newRowId`、`ensureRowIdColumn`、`readRowIdParam`、`findTransactionRowIndex`(rowId+内容一致、未採番行へのフォールバック)、`backfillRowIds`(レジストリ全 source の既存行の採番、手動1回実行・冪等) |
| その他 | `isLineWebhookPayload`(webhook無視) |

## カテゴリ定数の所在

編集・登録用カテゴリは`lib/categories.ts`に集約。検索候補は対象sourceの登録済み支出から生成する。
