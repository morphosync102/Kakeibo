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
| `app/login/page.tsx` / `app/login/LoginForm.tsx` | ログイン画面(パスキーのみ。パスワード欄は U6 で削除)。アプリロックのロック画面(`reason=locked`、「ロックしました」を表示し localStorage は消さない)も兼ねる。チャレンジを先に取得(4分で取り直し)し、取得直後に1回だけ自動で顔認証(ログアウト直後 `loggedOut=1`・非対応・アプリ内ブラウザーは除く。判定は `lib/passkey-client.ts` の `shouldAutoStartPasskey` / `createAutoStartGate`)、失敗・キャンセルは静かに「顔認証でログイン」ボタンへ。`reason=session` で `kakeibo_` の localStorage を消去、ログイン成功時に利用者が変わっていれば消去して `kakeibo_user` を記録、`markAppActive` でアイドル時計を戻し、サーバーが検証した `redirectTo` へ全画面遷移 |
| `app/invite/page.tsx` | 招待リンク `/invite#<token>` からのパスキー登録(公開)。フラグメントを読み、通常ブラウザーでは直ちにアドレスバーから消す(アプリ内ブラウザーでは「Safariで開く」に渡すため残し、登録完了後に消す。`shouldClearInviteFragment`)、アプリ内ブラウザー案内・トークン無しのエラーに「長押しでコピーして Safari に貼り付け/iMessage」の案内、登録後に `kakeibo_user` 記録・`markAppActive`・ホーム画面追加の案内 |
| `app/settings/passkeys/page.tsx` | 本人のパスキー(要ログイン、source 非依存)。一覧・失効・全端末ログアウト(2回タップ、成功で `logout()`)と追加(既存パスキーで再認証 → 登録の2タップ。パスキー0件の管理者だけパスワード再入力で最初の1つ) |
| `app/settings/line/page.tsx` | LINE 連携(`lineOptional` の source を持つ利用者)。コード発行・表示 → 5秒ごとに状態確認 → 候補の表示名で確定/取消 |
| `app/api/auth/passkeys/{list,revoke}/route.ts` / `app/api/auth/logout/all/route.ts` | 本人のパスキー一覧(`authListCredentials`)・失効(`authRevokeCredential`)・全端末ログアウト(`authBumpEpoch`)。失効・全端末ログアウトはこの端末の Cookie も削除 |
| `app/api/auth/line-link/{code,status,confirm}/route.ts` | LINE 連携の本人操作(`authCreateLineLinkCode` / `authGetLineLinkCandidate` / `authConfirmLineLink`)。actor はセッションから、`lineOptional` の source が無ければ 403 |
| `app/api/line/webhook/route.ts` | LINE webhook(公開)。生本文で署名検証(不正 401)→ 200 を即答 → `after()` で連携コードを `authLinkLine` へ転送(`lib/line-webhook.ts`) |
| `app/api/auth/register/{options,verify}/route.ts` | 招待登録(公開)。トークンの SHA-256 だけを GAS へ(`authPeekInvite` / `authConsumeInviteAndAddCredential`)、`register` チャレンジCookie、成功で `amr=pk` のセッションとアプリロックの `kakeibo_active` |
| `app/api/auth/login/{options,verify}/route.ts` | パスキーログイン(公開)。options は GAS なし、verify は `lib/passkey-assertion.ts` → `amr=pk` のセッション・`kakeibo_active`(ロック解除)と検証済み `redirectTo` |
| `app/api/auth/passkeys/add/{options,reauth,verify}/route.ts` | パスキー追加(要セッション)。options: 本人のパスキーでの再認証用(`reauth`。0件は 403、パスワードの bootstrap は U6 で削除) / reauth: 再認証 → 登録用の新チャレンジ(`add`) / verify: `authAddCredential` |
| `app/api/expenses/route.ts` | **GASへの唯一のデータ用プロキシ**。GET・POSTとも `readSession` を独立検証(401+Cookie削除)→ source 検証(400)→ POST は `WRITE_ACTIONS` のみ(400)→ source ∈ セッションの sources(403)→ `GAS_AUTH_PROXY_SECRET` 必須(503)。クライアント由来の `key`/`authKey`/`actor*` を除去し、`key`・`authKey`・セッションの actor を付与。GAS の `SessionRevoked`→401+Cookie削除、`Forbidden`→403、`AuthUnavailable`→503。GETは `unstable_cache`(キーはタグ+クエリのみ、5分、配列以外は502でキャッシュしない。`fresh=1` は迂回)、`maxDuration = 60`、POSTは転送＋関連タグ無効化 |
| `app/api/auth/verify/route.ts` | 廃止したパスワードログインの跡(公開)。常に 404 `Not Found`(何も読まず、Cookie も GAS 呼び出しもなし。古いログイン画面に「終了しました」を出させるため残す) |
| `app/api/auth/session/route.ts` | 家計簿切替の表示用 `{ sources, homeSource }`(userId・秘密なし) |
| `app/api/auth/logout/route.ts` | この端末の Cookie 削除 |

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
| `SourceSwitcher.tsx` | 家計簿の切替(sources が2つ以上の利用者のみ。`/api/auth/session` を1回取得、同じタブのまま移動) | 全 View の上部 |

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
| `middleware.ts` | 公開パス以外をすべて保護(判定は `lib/access.ts`)。無効なセッションは API 401、画面は `/login?returnTo=&reason=session`(Cookie削除)。権限外 source の画面はホームへ。アプリロック: 有効なセッションで `kakeibo_active` が無効なら画面は `/login?returnTo=&reason=locked`、API は 401 `Locked`(セッションは残す)。通過した要求(prefetch 除く)で `kakeibo_active` を更新、`/login` を開くと削除 |
| `lib/access.ts` | 純粋関数: 公開パス(`isPublicPath`、完全一致+`/`終わりの接頭辞)、`decideAccess`(middleware の判定。`active` でロック判定、`/settings/*` は `isAccountPath` で source 非依存)、`isLockExemptPath`(`/api/auth/logout`)、`refreshesActivity`、`homePath`、`safeReturnTo`/`postLoginPath`(returnTo 検証)、切替用の `sourceChoices`/`switchSourceHref` |
| `lib/app-lock.ts` | アプリロックの定数(`APP_LOCK_IDLE_MS` = 30分。唯一の定義)とクライアント側の純粋関数(`isIdleExpired`、`visibilityAction`、`shouldPing`、`readLastActive`/`markAppActive`(`kakeibo_last_active`)、`lockedLoginPath`) |
| `lib/active-session.ts` | サーバー: アプリロックの `kakeibo_active` Cookie(`a1.<期限>.<userId>.<epoch>.<署名>`、用途別の導出鍵、31分スライド)の発行・検証・Cookie 属性 |
| `components/AppLockGuard.tsx` | ルート layout に置くクライアントのロック監視。公開パス以外で、操作時刻の記録と1分ごとの `/api/auth/session` ping、可視化・bfcache 復帰・最初のタップ・30秒ごとの確認で30分超ならロック画面へ(そのタップは握りつぶす。書き込みキューが空になってから遷移) |
| `lib/client-session.ts` | クライアント: `kakeibo_` 始まりの localStorage 消去、`rememberLoginUser`(利用者変更時の消去)、`handleSessionExpired`(401 時)、`handleAppLocked`(401 `Locked`。消去せずロック画面へ)、`handleUnauthorized`(エラー語で振り分け)、`unauthorizedError`、`logout` |
| `lib/gas-auth.ts` | サーバー: GAS 認証系アクションの呼び出し `callGasAuth`(`key`+`authKey`、エラーは GAS のコードで返す。ログは呼び出し側で秘密を伏せて出す) |
| `lib/webauthn.ts` | サーバー(Node のみ): `@simplewebauthn/server` の薄いラッパー。`webauthnConfig`(`WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN` のみ、Host から導出しない)、登録・認証オプション生成、検証(例外は握りつぶして null)、応答の形式検査、userHandle → userId、GAS の credential 形式への変換 |
| `lib/webauthn-challenge.ts` | サーバー: チャレンジCookie `kakeibo_webauthn`(`wa1.`、用途別の導出鍵で署名、5分、purpose と binding を固定)、`sha256Hex`(challengeHash・招待トークンハッシュ) |
| `lib/passkey-assertion.ts` | サーバー: assertion 検証の共通処理(userHandle → `authGetCredential` → 所有者一致 → 署名・カウンタ → `authRecordCredentialUse`) |
| `lib/line-webhook.ts` | サーバー: LINE 署名(HMAC-SHA256 Base64、定数時間比較)、連携コードらしきメッセージの抽出、`authLinkLine` への転送と(`LINE_CHANNEL_ACCESS_TOKEN` 設定時のみ)成功時の返信 |
| `lib/passkey-flow.ts` | サーバー: GAS エラー → HTTP の固定エラー対応表、JSON 本文の読み取り、招待トークンの形式検査 |
| `lib/passkey-client.ts` | クライアント: `/api/auth/*` への POST、固定文言のエラー表示、招待フラグメントの読み取り、アプリ内ブラウザー判定、チャレンジの鮮度 |
| `lib/expense-identity.ts` | `isSameExpense()`: 両方に `rowId` があれば rowId 比較、なければ MessageId+日付+店舗+金額の従来比較(旧 localStorage キャッシュ互換) |
| `lib/expenses-proxy.ts` | プロキシ用の純粋関数: `isAllowedSource()`(省略/main/yahoo/yuki。レジストリと一致をテストで検査)、`WRITE_ACTIONS`(GAS と一致をテストで検査)、`parseGasList()`(配列以外は例外、GAS エラーは `GasResponseError`)、`gasErrorStatus()`、`toGasQuery`/`withGasAuth`/`toGasBody`(サーバー専用フィールドの除去と付与)、`redactSecret()`(複数の秘密を伏せる) |
| `lib/session.ts` | サーバー用 v2 セッション(userId・epoch・sources(ホーム先頭)・amr)の発行 `createSession`(`amr=pk` のみ)と検証 `readSession`(`amr=pwd` は常に無効、v1 は無効)。Cookie 属性、定数時間比較 `constantTimeEqual` |
| `lib/write-queue.ts` | クライアント書き込みの直列化。`postWrite()` が `/api/expenses` への POST(`keepalive`、45秒タイムアウト。時間切れは失敗確定ではない `WriteTimeoutError`)を1本の Promise チェーンで順に送る(失敗・時間切れでも次を送る)。未完了数の購読/取得と完了数、取得結果を適用してよいかの判定 `shouldApplyFetch()`、破棄後の動作 `fetchDiscardAction()` |
| `gas/コード.js` | **GAS ソースの正本**(約900行、clasp で本番と同期)。変更時は `.agents/skills/kakeibo-gas/SKILL.md` の手順に従う |
| `gas/appsscript.json` | GAS マニフェスト(タイムゾーン・Web アプリ設定) |
| `.github/workflows/deploy.yml` | main への push で test → GAS(稼働中ビルドから `gas/` に差分がある時のみ。`GAS_BUILD` に SHA を埋めて clasp push/deploy → `?action=version` で確認)→ Vercel(prebuilt)本番デプロイ(承認者なし、push が承認ゲート) |
| `scripts/gas-build.mjs` | 稼働中 GAS の `?action=version` を問い合わせてビルド SHA だけを出力(応答本文・key は出さない) |
| `test/*.test.mjs` | `node --test`。`gas-*.test.mjs` は VM sandbox で `gas/コード.js` を評価して回帰テスト |
| `test/statistics-search.browser.mjs` | `npm run test:e2e`。架空APIによる両source・期間切替・検索・編集削除・レスポンシブなモーダル操作のブラウザー回帰 |
| `test/session.test.mjs` / `test/auth-routes.test.mjs` | v2 セッションの改ざん(amr 含む)・期限・鍵・v1 拒否・`amr=pwd` の常時拒否(`APP_PASSWORD` が残っていても)、Middlewareを経由しないAPIハンドラーの認証、`/api/auth/verify` の常時404・bootstrap ルートの削除・アプリコードが `APP_PASSWORD` を参照しないこと、session/logout |
| `test/access.test.mjs` | middleware の判定の表駆動(利用者×パス)、公開パスと類似パス、アプリロック(locked の振り分け・公開パス除外・logout 例外・スライド更新・prefetch・`/login` での削除)、returnTo 検証、切替先、middleware.ts の実行 |
| `test/expenses-proxy.test.mjs` / `test/client-session.test.mjs` | プロキシの 403・許可リスト・actor/authKey の除去と付与・GAS エラー変換・キャッシュキーとログに秘密が出ないこと / localStorage 消去の条件、401 `Locked` では消去せずロック画面へ(取得・書き込み・設定画面)、ログイン画面にパスワード欄が無いこと |
| `test/helpers/load-route.mjs` | Route Handler・middleware を VM で実行するテスト用ハーネス(テストではない。`cookies` で `kakeibo_webauthn` 等も渡せる) |
| `test/app-lock.test.mjs` | アプリロック: 30分の定数と一箇所定義、`kakeibo_active` の署名・期限・userId/epoch の紐づけ・改ざん・鍵の分離、アイドル判定・可視化復帰・ping 間隔・returnTo、`AppLockGuard` の配線 |
| `test/helpers/legacy-session.mjs` | 廃止した `amr=pwd` セッションを旧形式で作るテスト用ヘルパー(拒否の確認用。テストではない) |
| `test/passkey-routes.test.mjs` / `test/webauthn-challenge.test.mjs` | パスキーの登録・ログイン・追加(再認証。旧 bootstrap Cookie の拒否)、ログイン・登録時の `kakeibo_active` 発行、チャレンジの再利用・期限・目的違い・対象違い、カウンタ後退、userHandle 不一致、設定不備時の 503 / チャレンジCookie・RP 設定・固定版・クライアント補助 |
| `test/account-routes.test.mjs` / `test/line-webhook.test.mjs` | 本人のパスキー一覧・失効・全端末ログアウトと LINE 連携 API(本人以外の操作不可、表示名確定フロー)/ webhook の署名(正・誤・欠落・生本文改変)・転送の可否・返信・ログ非出力 |
| `test/helpers/soft-authenticator.mjs` / `test/helpers/fake-gas-auth.mjs` | ソフトウェア認証器(実 ES256 署名・CBOR attestation)/ 認証 API 契約に従うメモリ上の GAS(テストではない) |
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
