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

| source | 用途 | 画面ルート | シート | 月次レポート宛先 Property | Web App |
| --- | --- | --- | --- | --- | --- |
| `main`または未指定 | 家庭用 | `/`, `/statistics`, `/calendar`, `/manage` | `Data` / `Config` / `Fixed` | `LINE_DESTINATION_MAIN` | 利用可 |
| `yahoo` | 個人用 | `/yahoo`, `/yahoo/statistics`, `/yahoo/calendar`, `/yahoo/manage` | `Yahoo_Data` / `Yahoo_Config` / `Yahoo_Fixed` | `LINE_DESTINATION_YAHOO` | 利用可 |
| `yuki` | Yuki 用 | (未実装。U1 で `/yuki` 配下を追加予定) | `Yuki_Data` / `Yuki_Config` / `Yuki_Fixed` | `LINE_DESTINATION_YUKI` | actor 必須(actor 無しは`{ "error": "Forbidden" }`。§4「利用者の照合」) |

コンポーネント、API、GASの全レイヤーでsource分離を維持します。
GASはsourceレジストリ(`gas/コード.js`の`SOURCES`)を正本とし、シート名・キャッシュキー・LINE宛先・ラベルを
すべてレジストリから引きます。未知のsource(内部処理での省略を含む)は例外とし、`main`へは落ち込みません。
「未指定=main」はWeb App入力(`doGet`/`doPost`の`source`)の旧クライアント互換としてのみ残しています。
`yuki`のシートはGASエディタで`setupSourceSheets()`(または`setupSourceSheets('yuki')`)を実行して作成します(§3)。

## 2. 画面仕様

下部タブは「レポート・統計・カレンダー・管理」の順で、遷移先でもsourceを維持します。

### 認証

- `/login`で`APP_PASSWORD`と入力値を照合します。
- 成功時はHMAC-SHA256で署名した`kakeibo_session`を30日間設定します。CookieはHttpOnly・SameSite=Strict・Path=/で、本番ではSecureです。
- トークンにはバージョン、発行時刻、有効期限、ランダムnonce、署名を含みます。サーバーで署名と30日間の期限を検証し、不正形式・改ざん・期限切れ・未来の発行時刻（60秒を超える時計差）を拒否します。
- `middleware.ts`が画面とAPIを保護し、`/api/expenses`のGET・POSTもGASアクセス前に独立して同じ検証を行います。
- `SESSION_SECRET`が未設定・不正な場合は認証を許可しません。旧形式のCookieは無効になり、再ログインが必要です。
- セッションはサーバーに保存しない方式です。個別のセッション失効はなく、有効なトークンは期限まで利用可能です。全セッションを失効させるには署名鍵をローテーションします。パスワード変更だけでは既存セッションは失効しません。

### レポート

- 当月を初期表示し、月カードの横スワイプで表示月を切り替えます。
- 月ごとの収入、支出、収支、カテゴリ別円グラフ、明細履歴を表示します。
- `Type === "Income"`のみ収入、それ以外は支出です。
- 履歴の明細を選ぶと詳細モーダルを表示します。

### 明細詳細

レポート、カレンダー、支出検索結果の明細から同じ詳細モーダルを開きます。

- モーダルはPortalでbody直下に配置し、下部タブより前面に表示します。
- 動的ビューポート高と上下のセーフエリアに合わせて高さを制限し、削除ボタンまで内部スクロールできます。
- 表示中は背景スクロールを止め、閉じると元の位置・スタイル・フォーカスへ戻します。
- ダイアログ内でTab移動し、Escapeまたは閉じるボタンで閉じられます。

- 選択した明細1件の日付を変更できます(`YYYY/MM/DD`のみ、時刻は扱いません)。
- 選択した明細1件の金額を変更できます(正の数のみ)。
- カテゴリ変更は範囲を選択できます。候補は明細の種別で切り替わります
  (`lib/categories.ts`、両source共通)。
  - 支出: 未分類・食費・カフェ・交通費・音ゲー・ダーツ・日用品・交際費・医療費・
    住居費・インフラ・旅行・その他・固定費・身だしなみ
  - 収入: 給料・臨時収入・賞与・立て替え・その他
  - 「この店舗すべて」: 同じ店舗名の既存明細を両source(家庭用・個人用)で更新し、
    Configにも今後の自動分類ルールとして保存します(2タップ確認)。
    GAS側の対象範囲は利用者の権限で絞られます(§4「POST actions」の`updateCategory`)。
  - 「この明細のみ」: 選択した1件だけを変更し、自動分類ルールは変更しません。
- 明細1件を削除できます(2タップ確認)。
- 破壊的でない書き込みは楽観的更新で即時反映し、結果はトーストで通知します。
  書き込みは送信順に1件ずつGASへ送り(`lib/write-queue.ts`)、同じ明細への連続編集が
  前の変更後の値で照合されるようにします。各書き込みは45秒でタイムアウトし、次の書き込みへ進みます。タイムアウトは失敗確定ではない(GASで反映済みの
  可能性がある)ため、入力欄の復元や失敗扱いはせず「反映されている可能性があります。一覧で確認してください」と
  表示し、その後の再取得で収束させます。
  再取得結果は、取得中にローカル変更があった場合、取得開始時または終了時に未完了の書き込みがある場合、
  取得中に書き込みが完了した場合は画面に適用せず、書き込みがなくなった時点で取り直します。

明細1件の更新・削除は、同じMessageIdを共有する別明細の誤操作を防ぐため、
次をすべて照合します。

- MessageId
- 変更前日付
- 店舗名
- 変更前金額

### カレンダー

- 月単位で移動し、日ごとの収入・支出合計を表示します。
- 選択日の明細一覧を表示し、明細を選ぶと詳細モーダルを開きます。
- 上部の「カレンダー／支出検索」で切り替えます。初期表示はカレンダーで、切り替え中はそれぞれの状態を保持します。
- 月送りスワイプは月ヘッダー・日付グリッド内に限定し、明細・検索・モーダルには適用しません。

### 統計

- `/statistics`と`/yahoo/statistics`は共通画面で、初期表示・再訪時とも「全期間」です。
- 「全期間・年・月」を選択できます。年・月の初回値は当年・当月で、過去の期間も指定できます。
- 全期間は最初の明細月から最後の明細月まで、年は1〜12月を月別集計し、月は全日を日別集計します。途中の空白期間は0です。
- 総収入・総支出・収支、収入／支出の棒グラフ＋収支の折れ線、別グラフの累積収支を表示します。
- 累積収支は選択期間の開始前を0として各期間の収支を加算します。グラフのタップで金額を表示し、表でも確認できます。
- 選択期間のカテゴリ別支出（金額・構成比・横棒）を金額降順で表示します。空カテゴリは「未分類」です。
- 全期間では、カテゴリ×年の年間支出表（年は降順、カテゴリは全期間合計の降順、最下行に年合計）も表示します。
- `Income`のみ収入、それ以外は支出として集計します。店舗ランキングは含めません。

### 支出検索

- 初期対象は全期間の全支出で、カレンダーの月・選択日とは独立しています。
- 店舗名・内容の部分一致、開始日・終了日、カテゴリ、最小・最大金額をANDで適用し、入力時に結果を更新します。
- キーワードはNFKCで全角半角を正規化し、前後の空白と英字の大小を無視します。
- カテゴリ候補は対象sourceの登録済み支出から生成し、空カテゴリは「未分類」です。収入は検索対象外です。
- 日付・金額の境界は両端を含み、片側指定もできます。金額は0以上の有限の数値（小数可）で、逆転範囲・不正入力は項目付近にエラーを出し結果を表示しません。
- 「条件をクリア」で全条件と表示件数の上限をリセットします。
- 件数・全検索結果の支出合計を表示し、年を含む日付の降順に店舗名・カテゴリ・金額を50件ずつ表示します。「もっと見る」で次の50件を追加します。
- 結果から共通の明細詳細を開き、編集・削除後も条件を維持して件数・合計・該当結果を再計算します。
- 統計と検索は既存の`useExpenses(source)`を使用します。読み込み・該当なし・取得失敗を区別し、失敗時にはキャッシュを保持して「再取得」を表示します。

### 管理

- 収入・支出を手動登録できます。
- 固定費を追加・削除できます。
- 固定費はGASの日次トリガーで、設定日の当月明細として1回だけ追加されます。

## 3. データモデル

Spreadsheet IDはGAS Script Property `SHEET_ID`から取得します。
各sourceのData / Config / Fixedは同じ列構成です(§1のデータソース表)。

#### sourceのシート作成(`setupSourceSheets`)

GASエディタから`setupSourceSheets()`を実行すると、レジストリの全sourceについて、存在しないシートだけを
下記の見出し行付きで作成します(Dataは見出しにH列`RowId`を含むため`backfillRowIds()`は不要)。
既存のシートは一切変更しないため冪等で、実際には新しいsource(`Yuki_*`)だけが作られます。
`setupSourceSheets('yuki')`のようにsourceを指定すると、そのsourceだけを対象にします(未知のsourceは例外)。
Script Lock内で実行し、シートを作成したsourceのキャッシュを無効化します。

### Data / Yahoo_Data / Yuki_Data

| 列 | 名前 | 内容 |
| --- | --- | --- |
| A | Date | `YYYY/MM/DD` |
| B | Merchant | 店舗名・内容 |
| C | Amount | 金額 |
| D | Category | カテゴリ。空の場合は表示・集計時に`未分類` |
| E | MessageId | メールID、固定費ID、手動入力ID |
| F | Timestamp | 登録日時 |
| G | Type | `Income`または`Expense`。空やその他は支出扱い |
| H | RowId | 行ごとに一意なID(UUID形式の値)。追加時に採番。既存行は`backfillRowIds()`で採番 |

MessageIdは常に一意とは限りません。同じメールから複数明細を抽出した場合、
複数行が同じMessageIdを共有します。MessageIdはメール取込の重複判定に使うため残し、
行の識別にはRowIdを使います。

RowIdは列番号に依存する既存処理(G列の種別、月次レポート等)を壊さないよう末尾(H列)に置き、
数式ではなく値で書き込みます。明細を追加する全経路(`addTransaction`、固定費の自動登録、
楽天/Olive/JCBのメール取込)で`Utilities.getUuid()`により採番します(いずれも新規行のH列にのみ書き込み)。

H列はUUID形式(`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)の値だけをRowIdとして扱います。手入力のメモ等が
入っている行はRowId未採番として扱い(一覧の`rowId`にも含めない)、従来の厳密照合で更新・削除できます。

#### RowIdの導入手順

1. GASをデプロイする(新規行からRowIdが付く。既存行はRowId無しのまま従来の照合で動作)。
2. GASエディタから`backfillRowIds()`を1回実行する(Script Lock内でレジストリ全sourceのData
   (Data/Yahoo_Data/Yuki_Data。存在しないシートは0件)を別々に処理し、
   H列が空の行だけ採番、H1が空ならヘッダ`RowId`を書き込み、各sourceのキャッシュを無効化。
   冪等なので再実行しても既存値は変わりません)。
   H列が既に別用途で使われている場合(H1が空でも`RowId`でもない、またはH2以降にUUID以外の値がある)は、
   全シートとも何も書き込まずにエラーで中止します(メッセージはシート名と件数のみ)。
   H列の内容を別の列へ移してから再実行してください。
3. UIをデプロイする(UIはbackfill前でも、旧GASでも動作します)。

シートへ手作業で行を追加した場合は、`backfillRowIds()`を再実行してRowIdを採番します。

### Config / Yahoo_Config / Yuki_Config

| 列 | 名前 | 内容 |
| --- | --- | --- |
| A | 支払い先 | 自動分類に使う部分一致キーワード |
| B | 分類 | カテゴリ |

### Fixed / Yahoo_Fixed / Yuki_Fixed

| 列 | 名前 | 内容 |
| --- | --- | --- |
| A | Type | `Income` / `Expense` |
| B | Name | 明細名 |
| C | Amount | 金額 |
| D | Day | 毎月の登録日 |
| E | Category | カテゴリ |

### 認証シート(Auth_Users / Auth_Credentials / Auth_Invites / Auth_LineLinks)

GASエディタの`setupAuthSheets()`が作成します(§4「認証API」の運用手順)。列は見出し名で特定するため順序は問いません。
どのシートも、セルの値が`=` `+` `-` `@`で始まらないようにします(表示名・ラベルは入力時に拒否、生成値はその文字で始まらない)。

| シート | 列 | 内容 |
| --- | --- | --- |
| `Auth_Users` | userId, displayName, role, sources, homeSource, epoch, status, createdAt, updatedAt | userIdは`u_`+128ビット乱数(base64url)。roleは`admin`/`member`。sourcesはカンマ区切り。epochは0以上の整数。statusは`active`/`disabled` |
| `Auth_Credentials` | credentialId, userId, publicKey, counter, transports, deviceType, backedUp, label, createdAt, lastUsedAt, revokedAt | credentialId・publicKey(COSE公開鍵)はbase64urlに接頭辞`b64u:`を付けて保存(`-`始まりの値を数式扱いさせないため)。counterは数値。transportsはカンマ区切り。revokedAtが空でなければ失効(行は削除しない) |
| `Auth_Invites` | inviteId, tokenHash, userId, purpose, expiresAt, createdBy, usedAt | tokenHashは招待トークンのSHA-256(小文字16進64桁)。トークン自体は保存しない。purposeは`register`/`recovery`。usedAtが空でなければ使用済みまたは無効化済み |
| `Auth_LineLinks` | linkId, userId, source, codeHash, status, expiresAt, candidateExpiresAt, createdAt, resolvedAt | LINE連携。codeHashは連携コードのSHA-256(16進)。statusは`pending`/`candidate`/`confirmed`/`cancelled`/`replaced`。LINE userId・表示名は保存しない(候補のLINE userIdはScript Cacheに10分だけ保持し、確定したら宛先Propertyにのみ保存) |

日時はISO 8601文字列で書き込みます(シートが日時型に変換しても読めます)。

## 4. API契約

ブラウザは直接GASへアクセスせず、Next.jsの`/api/expenses`を経由します。
Next.jsは`GAS_API_URL`へリクエストを転送します。

### プロキシ認証(GAS)

GAS Web AppはURLを知っていれば誰でも呼べるため、プロキシとGASで共有シークレットを照合します。

- プロキシ: Vercel環境変数`GAS_PROXY_SECRET`があれば、GETはGASへのクエリ、POSTは本文に`key`として付与します。
  クライアントが送った`key`は常に削除・上書きし、レスポンス・ログ・`unstable_cache`のキャッシュキーには含めません
  (キーは送信直前にのみ付与)。未設定なら付与しません(移行期間)。
- GAS: Script Property`PROXY_SECRET`が設定されていれば、doGetはクエリ`key`、doPostは本文`key`を
  SHA-256ダイジェストの全バイト比較(定数時間)で照合し、不一致・欠落は`{ "error": "Unauthorized" }`を返します
  (sourceの検証より前)。未設定なら警告ログを出して通します(移行期間)。
- GASの`Unauthorized`は、プロキシのGETでは配列以外として502、POSTでは`{ error }`のままUIへ返り失敗として扱われます。
- LINE webhook形式のPOSTはLINEから直接届くため照合対象外ですが、成功応答で無視するだけで明細の読み書きはしません。
  時間トリガー(関数の直接実行)は影響を受けません。

移行手順:

1. GASをデプロイする(`PROXY_SECRET`未設定のため従来どおり動作)。
2. Vercelの**Production**環境に`GAS_PROXY_SECRET`を設定し、UI/プロキシを再デプロイする(GASは未設定のため`key`を無視)。
   値は英数字のみの暗号学的乱数にする(例: `openssl rand -hex 32`)。
3. GASのScript Property`PROXY_SECRET`に同じ値を設定して照合を有効化する(GASの再デプロイ不要、次のリクエストから有効)。
   直後に一覧表示と書き込みの両方を確認し、`Unauthorized`になる場合はPropertyを削除すれば即座に元へ戻せる。
4. 動作確認後、GASの「未設定なら通す」処理を削除し、未設定時は拒否にする(後続タスク、IMPROVEMENTS 4-1)。

### 利用者の照合(actor、GAS)

設計書`docs/design/2026-11-yuki-and-passkeys.md` §5.7。プロキシはセッションから得た利用者を
GETクエリ/POST本文の`actorUserId`(文字列)と`actorEpoch`(0以上の整数。クエリでは数字列)としてGASへ渡します
(クライアント送信分は除去。プロキシ側はU2で実装予定。現行UI・現行プロキシは送りません)。
actorを付けるときは、`key`とは別の秘密`authKey`(Vercel`GAS_AUTH_PROXY_SECRET` = GAS`AUTH_PROXY_SECRET`)も付けます。
現行の`/api/expenses`は本文をそのまま転送して`key`を付け直すため、`key`だけではブラウザが自称したactorと区別できないからです。

GASはdoGet/doPostで`key`照合 → source検証 → actor照合の順に判定し、失敗時は何も読み書きしません。

| 状況 | 応答 |
| --- | --- |
| actorのフィールド(`actorUserId`/`actorEpoch`)が1つでもあり、`authKey`が`AUTH_PROXY_SECRET`と一致しない(欠落・誤り・`AUTH_PROXY_SECRET`または`PROXY_SECRET`未設定を含む) | `{ "error": "Unauthorized" }` |
| `actorUserId`/`actorEpoch`の片方だけ、形式不正(IDは英数字`_-`の1〜64文字) | `{ "error": "Invalid actor" }` |
| actor無し、かつ source が`yuki`(レジストリの`requiresActor`)またはScript Property`AUTHZ_ENFORCE`が`1` | `{ "error": "Forbidden" }` |
| actor無し、`main`/`yahoo`、`AUTHZ_ENFORCE`未設定(`1`以外) | 従来どおり許可(旧UI互換) |
| `Auth_Users`シートが無い・必須列(userId/sources/epoch/status)が無い・読めない | `{ "error": "AuthUnavailable" }`(fail closed) |
| 利用者が存在しない、`status`が`active`以外、`epoch`不一致 | `{ "error": "SessionRevoked" }` |
| sourceが利用者の`sources`に無い | `{ "error": "Forbidden" }` |

- ユーザー表`Auth_Users`(列は見出し名で特定: userId, displayName, role, sources, homeSource, epoch, status,
  createdAt, updatedAt。sourcesはカンマ区切りのsource id)は認証系(G3)が作成・更新し、GASのデータ処理は読むだけです。
  同じuserIdが複数行あれば(形式不正の行を含む)その利用者は信頼しません(全行無視)。
- 解析済みのユーザー表はScript Cacheに、データ一覧と同じ世代方式で保存します
  (世代`kakeibo_auth_users_gen`、表`kakeibo_auth_users_v1_<世代>`、10分)。ヒット時はシートを開きません。
  読み込みはシートを読む前に世代を取得し(無ければ作成)、保存直前に世代が変わっていれば保存しません。
- G3との契約: `Auth_Users`へ書き込む処理は、Script Lockを持ったまま書き込み後に`clearAuthUsersCache()`を呼びます。
  `clearAuthUsersCache()`は`SpreadsheetApp.flush()`で書き込みを確定させてから世代を切り替えるため、
  次の要求から新しいepoch・status・sourcesが効きます(書き込みと並行して読み始めた古い表が残ることはありません)。
  例外は投げず(書き込みは成功済み)、世代の切替に失敗した場合は現世代の表を削除して代替します
  (それも失敗した場合は最大10分古い表が残り得ます)。
- 手作業で編集した場合はGASエディタから`clearAuthUsersCache()`を実行します(実行しなくても最大10分で反映)。
- 時間トリガー・エディタ関数はactor照合の対象外です。
- `AUTHZ_ENFORCE=1`は全利用者がactor付きのUIへ移行した後に設定します(再デプロイ不要、削除で即時に戻せる)。

### 認証API(GAS 認証系アクション)

設計書§3・§5.6。GASはWebAuthnの署名を検証しません。Next.jsサーバーが`@simplewebauthn/server`で検証した結果だけを受け取り、
保存・照合(招待の1回性、チャレンジの1回性、epoch)を行います。すべてPOSTで、本文に`key`が必要です。

- 認証系アクションは`key`(`PROXY_SECRET`)に加えて本文の`authKey`が`AUTH_PROXY_SECRET`と一致する必要があります(定数時間比較)。
  `PROXY_SECRET`・`AUTH_PROXY_SECRET`のどちらかが未設定、または`authKey`の欠落・誤りは`{ "error": "Unauthorized" }`で、
  何も読み書きしません(移行期間の素通しを適用しない)。`authKey`は新しい`/api/auth/*`だけが送り、`/api/expenses`経由では
  届きません(U2で`/api/expenses`のPOSTを`WRITE_ACTIONS`の許可リストに限定し、クライアント由来の`authKey`等を除去)。
  2つの値が同じでも`key`は`authKey`として扱いません(`setupAuthSheets()`が同値・未設定を警告)。値はログに出しません。
- `source`は見ません(データ用のsource検証・actor照合より前に分岐)。
- 書き込みはScript Lock内で状態を読み直してから行い、取得できなければ`{ "error": "Busy" }`です。`Auth_Users`を書き換えたら
  ロック内で`clearAuthUsersCache()`を呼びます(データ側のactor照合に即時反映)。
- 想定外の例外は`{ "error": "AuthError" }`だけを返します(内容はログのみ)。応答・ログに招待トークン・トークンハッシュを含めません。
- 入力形式: `tokenHash`・`challengeHash`は小文字16進64桁(SHA-256)。`credentialId`・`publicKey`はbase64url。
  不正なら何も読み書きせず`{ "error": "Invalid input" }`。actorは`actorUserId`/`actorEpoch`(§「利用者の照合」と同じ形式、欠落・不正は`Invalid actor`)。
- `credential`(検証済みの登録結果): `{ credentialId, publicKey, counter(0〜2^32-1の整数), transports?: ("usb"|"nfc"|"ble"|"internal"|"hybrid"|"cable"|"smart-card")[], deviceType?: "singleDevice"|"multiDevice", backedUp?: boolean, label?: string(1〜40文字、= + - @ で始まらない。省略時「パスキー」) }`。

| action | 用途 | 入力 | 成功時 | 主なエラー |
| --- | --- | --- | --- | --- |
| `authGetAdminUser` | パスワードログイン(移行期間)で管理者行を得る | なし | `{ success, user: { userId, displayName, role: "admin", sources, homeSource, epoch } }` | `AdminNotFound`(active な admin が0件)、`AdminAmbiguous`(2件以上)、`AuthUnavailable` |
| `authPeekInvite` | 招待の有効性確認(消費しない) | tokenHash | `{ success, purpose, user: { userId, displayName }, credentials: [{ credentialId, transports }] }`(excludeCredentials用) | `InviteInvalid`(存在しない・使用済み・無効化済み・期限切れ・利用者が active でない) |
| `authConsumeInviteAndAddCredential` | 招待の消費とパスキー追加(原子的) | tokenHash, challengeHash, credential | `{ success, user: { userId, displayName, sources, homeSource, epoch } }` | `InviteInvalid`、`CredentialExists`、`ChallengeReused` |
| `authAddCredential` | 再認証済みの本人がパスキーを追加 | actor, challengeHash, credential, bootstrap? | `{ success, credentialCount }` | `SessionRevoked`、`NoExistingCredential`(パスキー0件なのに bootstrap なし)、`BootstrapNotAllowed`(bootstrap は role=admin かつ有効なパスキー0件のときだけ)、`CredentialExists`、`ChallengeReused` |
| `authGetCredential` | ログイン検証用の公開鍵取得 | credentialId | `{ success, credential: { credentialId, userId, publicKey, counter, transports }, user: { userId, displayName, sources, homeSource, epoch } }` | `CredentialNotFound`(存在しない・失効済み・利用者が active でない) |
| `authRecordCredentialUse` | 認証成功の記録 | credentialId, counter, challengeHash | `{ success }`(lastUsedAt更新、counterは増えたときだけ更新) | `ChallengeReused`、`CredentialNotFound` |
| `authListCredentials` | 本人の有効なパスキー一覧(公開鍵なし) | actor | `{ success, credentials: [{ credentialId, label, deviceType, backedUp, createdAt, lastUsedAt }] }` | `SessionRevoked` |
| `authRevokeCredential` | 本人のパスキー失効 + epoch+1 | actor, credentialId | `{ success, epoch }` | `SessionRevoked`、`CredentialNotFound`(他人のもの・失効済みを含む) |
| `authBumpEpoch` | 本人の全端末ログアウト(epoch+1) | actor | `{ success, epoch }` | `SessionRevoked` |
| `authCreateLineLinkCode` | LINE連携コードの発行(1人1つ、再発行で旧コード無効) | actor, source? | `{ success, code, source, expiresAt }`(codeはこの応答にだけ含まれる) | `Forbidden`(本人の`lineOptional`のsourceでない、または候補が1つに決まらない)、`SessionRevoked` |
| `authLinkLine` | webhook(Vercelで署名検証済み)からのコード照合。成功しても候補として保留するだけ | code, lineUserId | `{ success }` | `LinkCodeInvalid`(存在しない・期限切れ・使用済み・置き換え済み)、`RateLimited` |
| `authGetLineLinkCandidate` | 本人の連携状態と候補のLINE表示名 | actor | `{ success, status: "none" }` / `{ success, status: "pending", source, expiresAt }` / `{ success, status: "candidate", source, displayName, expiresAt }` | `ProfileUnavailable`、`SessionRevoked` |
| `authConfirmLineLink` | 本人による確定または取り消し | actor, decision(`confirm`/`cancel`) | `{ success, decision }` | `NoCandidate`、`Forbidden`、`SessionRevoked` |

共通エラー: `Unauthorized`、`Invalid input`、`Invalid actor`、`AuthUnavailable`(認証シートが無い・列が無い)、`Busy`、`AuthError`。

#### LINE連携(宛先の設定)

設計書§5.4。宛先にできるのは、本人が持つsourceのうちレジストリで`lineOptional`のもの(現状`yuki`のみ)だけです。
`main`/`yahoo`の宛先(`LINE_DESTINATION_MAIN`/`LINE_DESTINATION_YAHOO`)はWebアクションからは設定できません
(発行時と確定時の両方で確認)。

- コード: 紛らわしい文字(`0 O 1 I l`)を除いた英大文字・数字32種の10文字(約50ビット)。GASが`newRandomBytes()`で生成し、
  ハッシュだけを保存します。有効10分、1回限り。照合は前後の空白を除き大文字にしてから行います。
- `authLinkLine`はScript Lock内で次の順に判定します。超過・ブロック中の試行は照合せず`RateLimited`です。
  - そのLINE userIdの直近10分の照合失敗が3回以上(そのLINE userIdだけをブロック)
  - そのLINE userIdの直近10分の試行が5回以上
  - 全体の直近10分の試行が20回以上
  - カウンタはScript Cache(キーはLINE userIdのハッシュ)。Cacheが使えないときは拒否します。
- 照合に成功すると、LINE userIdを候補としてScript Cacheに10分保持し、Auth_LineLinksを`candidate`にします。宛先Propertyはまだ変わりません。
- 本人が`authGetLineLinkCandidate`で表示名(LINEプロフィールAPI、`LINE_CHANNEL_ACCESS_TOKEN`使用)を確認し、`authConfirmLineLink`で
  `confirm`したときだけ宛先Property(`LINE_DESTINATION_YUKI`)を設定し、確認メッセージをpushします。`cancel`は候補とコードを破棄します。
- 失敗回数は(設計書の初版の「コードごと・3回で全コード失効」ではなく)LINE userIdごとに数えます。初版の方式では、公式アカウントの
  友だちなら誰でも誤ったコードを3回送るだけでYukiのコードを失効させられるためです。総当たりは50ビットのコードと全体20回/10分の制限で防ぎます。
- ログ・シート・応答に、連携コード(発行応答を除く)・LINE userId・表示名(候補取得の応答を除く)・トークンを出しません。

- 招待: 有効期限は24時間(管理者の`recovery`招待は10分)。1回限りで、消費はロック内で未使用・期限・利用者を再確認します。
  同じ利用者に新しい招待を発行すると、その利用者の未使用の招待はすべて無効になります。
- チャレンジの再利用防止: 状態の確認を通った要求だけが、ロック内で`challengeHash`をScript Cache(`kakeibo_auth_challenge_<hash>`、5分)に記録します。
  記録済みなら`ChallengeReused`で何も書き込みません(招待も消費しない)。Script Cacheが使えない場合は記録せず続行し(ログ)、
  Next.js側の署名付き5分チャレンジCookieが残りの防御です。
- 他人に対する操作(招待発行、利用者の追加・無効化、他人のパスキー失効・epoch更新)はWebアクションに存在せず、エディタ関数だけで行います。

#### 認証の運用(GASエディタ関数)

エディタの実行ボタンは引数を渡せないため、計画済みの操作には引数なしの関数を用意しています。

| 関数 | 用途 |
| --- | --- |
| `setupAuthSheets()` | 認証シートの作成と管理者行(role=admin、sources=main,yahoo、epoch 0)の作成。冪等(admin行が既にあれば作らない)。`AUTH_PROXY_SECRET`の未設定・`PROXY_SECRET`との同値を警告 |
| `addYukiUser()` = `addUser('Yuki', ['yuki','main'], 'yuki')` | 利用者の追加(role=member)。同じ表示名・role・sources(順不同)・homeSourceの利用者が既にあればそのuserIdを返す(冪等)。表示名が同じで属性が違う場合、未知のsource、homeSourceがsources外はエラー |
| `createYukiRegisterInvite()` / `createYukiRecoveryInvite()` / `createAdminRecoveryInvite()` = `createInvite(user, purpose)` | 招待の発行。URL `<APP_ORIGIN>/invite#<token>` は**実行ログにのみ**出力。戻り値・シートにトークンは残らない |
| `bumpAdminEpoch()` = `bumpEpoch(user)` | 全端末ログアウト(epoch+1) |
| `disableUser(user)` | 利用者の無効化(epoch+1) |
| `revokeCredential(user, credentialIdPrefix)` | パスキーの失効(完全なIDまたは8文字以上の一意な前方一致)+ epoch+1 |
| `listUsers()` | 利用者とパスキー(IDの先頭12文字、ラベル、日時)を実行ログへ。公開鍵は出さない |
| `clearAuthUsersCache()` | `Auth_Users`を手作業で編集した後に実行 |

`user`はuserIdまたは表示名(完全一致。同名が複数あればエラー)。引数が必要な関数を一時的に実行する場合は、
エディタ上で呼び出し用の関数を一時的に追加して実行し、終わったら削除します(リポジトリの`gas/コード.js`が正本のため次のデプロイで消えます)。
招待URLにはScript Property`APP_ORIGIN`(`https://<本番ドメイン>`、パスなし。開発時は`http://localhost:3000`)が必要です。

初回の手順(GASデプロイ後):

1. Script Propertyに`AUTH_PROXY_SECRET`(`PROXY_SECRET`とは別の英数字の暗号学的乱数。例`openssl rand -hex 32`)と`APP_ORIGIN`を設定する。
   旧UIは`authKey`を送らないため、設定しても既存の動作は変わりません。Vercelには同じ値を`GAS_AUTH_PROXY_SECRET`として設定する(U2)。
2. `setupAuthSheets()` → `setupSourceSheets()` → `addYukiUser()` → `listUsers()`で内容を確認する。実行ログに警告が無いことも確認する。
3. 最初に`createInvite`系を実行した後、`Auth_Invites`の`expiresAt`セルを一度開き、値の型(文字列のままか、シートが日時型に変換したか)と
   表示されている日時が「発行時刻 + 24時間(管理者の`recovery`は10分)」になっていることを確認する。続けて`authPeekInvite`相当の動作
   (UIの`/invite`を開く等)で期限内は有効と判定されることを確認する。日時型に変換されていても判定は動作する設計ですが、
   スプレッドシートのタイムゾーン設定による表示のずれが無いかをここで確認します。

乱数: Apps Scriptの`Utilities.getUuid()`は暗号学的乱数であることが公式に明記されていないため、UUID 4つ・時刻・`Math.random()`を連結して
SHA-256を通した32バイトを使います(入力のうち最も予測困難なものと同等以上の予測困難性)。招待トークンは256ビット(base64url 43文字)、
userId・inviteIdは128ビットです。

### GET

- `GET /api/expenses`: 対象sourceの明細一覧
- `GET /api/expenses?source=yahoo`: 個人用明細一覧
- `GET /api/expenses?action=getFixedCosts[&source=yahoo]`: 固定費一覧

GAS直接(プロキシ非経由、デプロイ確認用): `?action=version` → `{ "build": "<commit SHA または dev>" }`(認証対象)。

`source`はGET/POST共通で、GASはレジストリの`main`(家庭用)・`yahoo`(個人用)・`yuki`(Yuki用)と、
旧クライアント互換の省略・空文字(=`main`)を認識します。
- `actor`無しの要求(現行UI)で読み書きできるのは省略・空文字・`main`・`yahoo`です(`AUTHZ_ENFORCE`未設定時)。
- `yuki`は常に`actor`必須です。`actor`無しではGET/POSTとも`{ "error": "Forbidden" }`を返し、何も読み書きしません。
  `actor`付きの要求は次節「利用者の照合(actor)」の判定に従います。
- それ以外(`Yahoo`等の表記ゆれ、文字列以外を含む)は`{ "error": "Invalid source" }`を返し、何も読み書きしません。
- 「省略=main」の解釈はWeb App入力(`doGet`/`doPost`)だけで、GAS内部の関数(シート・キャッシュキー・宛先の解決)は
  sourceの明示を必須とし、省略・未知は例外にします。
Next.jsプロキシはGASを呼ぶ前に検証し、省略・`main`・`yahoo`以外(空文字を含む)は
HTTP 400 `{ "error": "Invalid source" }`を返します。

GAS一覧の応答は配列のみ正常です。プロキシは配列以外(GASの`{ error }`、非JSON、非200)を
HTTP 502 `{ "error": "Bad Gateway" }`で返し、キャッシュしません。

GETに`fresh=1`を付けると、プロキシはNext.jsのキャッシュを使わずGASを直接読みます(認証・source検証は
同様に先に行い、`fresh`はGASへのクエリにもキャッシュキーにも含めません)。書き込み完了後の再取得、
書き込みと重なって破棄した取得の取り直し、手動の再取得(明細・固定費)で使用し、起動時の取得は使用しません。
APIルートの`maxDuration`は60秒です(クライアントの書き込みタイムアウト45秒より長い)。

### POST actions

| action | 更新範囲 | 主な入力 |
| --- | --- | --- |
| `addTransaction` | 対象sourceへ明細1件追加 | date, merchant, amount, category, type |
| `deleteTransaction` | 対象sourceの明細1件削除。date/merchant/amountを渡すと厳密照合、id のみなら旧来の先頭一致 | id, [date, merchant, amount], [rowId] |
| `updateTransactionDate` | 対象sourceの厳密一致明細1件の日付更新 | id, currentDate, merchant, amount, date, [rowId] |
| `updateTransaction` | 対象sourceの厳密一致明細1件の金額・店舗名・カテゴリ更新(いずれか1つ以上) | id, currentDate, currentMerchant, currentAmount, [amount, merchant, category], [rowId] |
| `updateCategory` | カテゴリ共有グループ(`main`+`yahoo` / `yuki`)のうち利用者が権限を持つsourceの同一店舗カテゴリとConfig更新(下記) | merchant, category |
| `addFixedCost` | 対象sourceへ固定費1件追加 | type, name, amount, day, category |
| `deleteFixedCost` | 対象sourceの固定費1件削除。type/name/amount/dayを渡すと照合削除(idの行が一致すればその行、しなければ全行から最初の一致行、なければ`Fixed cost not found`)。idのみなら旧来の行番号指定 | [id], [type, name, amount, day, category] |

GASはJSONで`{ success: true, ... }`または`{ error: "..." }`を返します。
全書き込みactionはScript Lock内で行を読み直して照合してから書き込みます。20秒以内に
ロックを取得できない場合は何も変更せず`{ "error": "Busy" }`を返します(クライアントは失敗として扱う)。
Next.js POSTプロキシは、固定費系actionは`fixedCosts`タグ、それ以外は`expenses`タグを
完了後に再検証します(`revalidateTag(tag, { expire: 0 })`)。

`deleteFixedCost`はUIから`id`と照合フィールド(type/name/amount/day/category)を送ります。

`updateCategory`の対象source = 要求sourceのカテゴリ共有グループ ∩ actorの`sources`
(actor無しの旧クライアントはグループ全体)。対象sourceのDataとConfigだけを書き換え、対象sourceのキャッシュだけを無効化します。

| 実行者(sources) | 要求source | 書き換えるData / Config | 無効化するキャッシュ |
| --- | --- | --- | --- |
| actor無し(現行UI) | `main`または`yahoo` | `Data`・`Yahoo_Data` / `Config`・`Yahoo_Config` | main, yahoo(従来どおり) |
| 管理者(main, yahoo) | `main`または`yahoo` | `Data`・`Yahoo_Data` / `Config`・`Yahoo_Config` | main, yahoo |
| Yuki(yuki, main) | `main` | `Data` / `Config`のみ(`Yahoo_*`は変更しない) | main |
| Yuki(yuki, main) | `yuki` | `Yuki_Data` / `Yuki_Config`のみ | yuki |
| 管理者 / actor無し | `yuki` | (`Forbidden`) | — |

明細一覧(GET)の各要素は`id`(MessageId)、`date`、`merchant`、`amount`、`category`、`type`に加え、
H列に値があれば`rowId`を含みます(空なら省略)。

単一明細の更新・削除で`rowId`(文字列)を渡すと、Script Lock内でH列が一致する行を探し、
既存の照合値(MessageId・日付・店舗名・金額/変更前値)も一致する場合だけ更新・削除します。
RowIdが一致しても内容が違えば`Transaction not found`です(別の行へはフォールバックしない)。
シートにそのRowIdが無い場合は、RowIdが無い行(未backfill、またはH列がUUID以外)の中だけで従来の厳密照合を行います。
`rowId`を送らない旧クライアントは従来どおりです。UUID形式でない`rowId`は`Invalid rowId`です。
UIは単一明細の全書き込みで`rowId`を既存フィールドと一緒に送ります(旧GASは`rowId`を無視します)。

### 既知制約

- `deleteTransaction`はid(MessageId)のみで呼ばれた場合に限り、旧クライアント互換として
  先頭一致行を削除します。現行UIは常にdate/merchant/amountを送り厳密照合します。
- `deleteFixedCost`は照合フィールドが無い場合に限り、旧クライアント互換としてidを行番号として
  扱います。idは0以上の整数(数値または数字のみの文字列)で範囲内である必要があり、
  それ以外はエラーを返します。ヘッダ行は削除しません。

## 5. 自動処理

### メール取込

`runEmailExtraction()`がカード通知メールを読み取り、重複MessageIdを除外して追加します。
重複判定と追加はScript Lock内で行い、ロックを取得できない回は追加せずログを残して次回に持ち越します。

| 通知元 | 保存先 |
| --- | --- |
| 楽天カード | `Data` |
| Vpass / Olive | `Yahoo_Data` |
| JCBショッピング通知 | `Yahoo_Data` |

### 固定費

`processFixedCosts()`を日次トリガーで実行します。レジストリの全source(main → yahoo → yuki)を順に処理し、
FixedまたはDataシートが無いsourceはロックを取る前にスキップします。1つのsourceで例外が出ても残りのsourceは処理し、
最後に失敗したsource名を含む例外を投げます(トリガーの失敗通知が届く)。
`processFixedCostsForSource(source)`はsource必須です(省略・未知は例外。mainへの既定値はありません)。
IDは`fixed_<YYYYMM>_<名称>_<source>`(従来と同じ書式)で、
同月の重複登録を防ぎます。重複判定と追加はsourceごとにScript Lock内で行い、
ロックは最大120秒待ちます。取得できない回はその日の分が追加されず、翌日のトリガーでも
補完されない(当日日付の行のみ対象のため)ので、警告ログを確認して当日中に再実行または手入力します。

### 月次LINEレポート

- トリガー関数: `sendMonthlyKakeiboReports`
- 実行予定: 毎月10日 09:00
- 対象期間: 前月
- 送信先: sourceごとにレジストリの宛先Property(`LINE_DESTINATION_MAIN` / `LINE_DESTINATION_YAHOO` /
  `LINE_DESTINATION_YUKI`)。各sourceの明細はそのsourceの宛先にのみ送ります。
- レジストリの全sourceを順に処理します。1つのsourceで失敗しても残りのsourceは送り、
  最後に失敗したsource名を含む例外を投げます(トリガーの失敗通知が届く)。
- 宛先Propertyが未設定の場合: `main` / `yahoo`は従来どおり失敗(`Missing Script Property`)として扱います。
  レジストリで`lineOptional`の`yuki`だけは、LINE連携前を想定して警告ログを残して送信をスキップします。
  いずれの場合も他sourceの宛先へ送ることはありません。
- 内容: 収入、支出、収支、前月比、カテゴリ別支出、高額支出トップ5

LINE webhook形式のPOSTは、メール転送や家計簿更新をせず成功応答で無視します。

## 6. キャッシュ

| レイヤー | 方式 | 無効化 |
| --- | --- | --- |
| Browser | source別localStorage | `useExpenses.refresh()`とバックグラウンド取得で更新 |
| Next.js | `unstable_cache`(`expenses`/`fixedCosts`タグ、クエリ別キー)、5分再検証。GASへの生fetchは`no-store`。`fresh=1`は迂回 | POST完了後に`revalidateTag(tag, { expire: 0 })` |
| GAS | source・data/fixed別Script Cache、6時間 | GAS書き込み成功後に`clearCache(source)` |

GAS Script Cacheはsourceごとの世代トークン`kakeibo_{main|yahoo|yuki}_gen`(data/fixed共通、
Web Appのsource省略・空文字は`main`に正規化してから使う。キー生成は正規化済みのsourceのみ受け付け、
省略・未知は例外)を持ち、一覧は`<key>_<gen>_chunks`(チャンク数)と
`<key>_<gen>_0`〜(本体)に分割して`putAll`で保存します(`<key>`は`kakeibo_{src}_{data|fixed}`、
値の100KB上限対策、最大30チャンク)。

- 読み込みは現在の世代のキーだけを見ます。チャンクが1つでも欠けたらミス扱いでシートから読み直します。
- doGetはシートを読む前に世代を取得し(無ければ新規作成)、保存直前に世代が変わっていれば保存しません。
  書き込み前に読み始めた古い一覧がキャッシュに残ることはありません。
- `clearCache(source)`は`SpreadsheetApp.flush()`でシート書き込みを確定させてから世代を更新して
  既存キャッシュを無効化し、旧世代のチャンクと旧形式の単一キーをベストエフォートで削除します。
- `clearCache`は例外を投げません。書き込み成功後に無効化が失敗しても書き込みは`success`を返し
  (UIの再送による二重登録を防ぐ)、警告ログを残します。世代更新に失敗した場合は
  現世代のチャンクと旧形式キーの削除で代替します(これも失敗した場合は最大6時間古い一覧が残り得ます)。
- 保存失敗はログのみで一覧取得は成功させます。

Next.jsのGETは`unstable_cache`の中でGAS応答を検証し、配列以外なら例外にします。`unstable_cache`は
コールバックが正常に返った結果だけを保存するため、エラー応答はキャッシュに残りません
(fetchキャッシュは200応答を非同期に保存し、後からの`revalidateTag`では確実に消せないため使わない)。
書き込み前にGASを読み始めたGETが、POSTの`revalidateTag`より後に`unstable_cache`へ保存すると、
その古い一覧は有効扱いのまま残り得ます。このため書き込み後の再取得は`fresh=1`でGASを直接読み
(GAS側は世代トークンで古い一覧を返さない)、キャッシュの有効期間を5分に抑えています。

書き込み機能を追加する場合、影響する全キャッシュの更新または無効化が必要です。

## 7. 設定と秘密情報

### Vercel環境変数

- `APP_PASSWORD`
- `SESSION_SECRET`: 暗号学的乱数32バイトを64文字の16進数で設定する、サーバー専用の署名鍵。パスワードから生成せず、ソース・ログには保存しません。本番デプロイ前に設定が必要です。ローカル開発でも独立した鍵を環境変数に設定します。
- `GAS_API_URL`
- `GAS_PROXY_SECRET`: GASとの共有シークレット(プロキシ認証)。GASの`PROXY_SECRET`と同じ値。

### GAS Script Properties

- `SHEET_ID`
- `APP_ORIGIN`: 招待URLの生成に使うアプリのオリジン(`https://<本番ドメイン>`、パスなし)。`createInvite`系の実行に必須。秘密値ではない
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_DESTINATION_MAIN`
- `LINE_DESTINATION_YAHOO`
- `LINE_DESTINATION_YUKI`: Yuki の月次レポート宛先(LINE userId)。任意。未設定の間は yuki の月次レポートを送らない。
  通常は手で設定せず、Yuki 本人の LINE 連携(`authConfirmLineLink`)で設定される
  (値の設定方法は設計書 §5.4 の LINE 連携。G4 で実装予定)
- `AUTHZ_ENFORCE`: `1`で全データ要求にactorを必須にする(未設定・`1`以外は移行期間: actor無しのmain/yahooを許可)。秘密値ではない
- `AUTH_PROXY_SECRET`: 認証系アクションとactor付き要求の`authKey`を照合する共有シークレット。`PROXY_SECRET`とは別の値にし、
  Vercelの`GAS_AUTH_PROXY_SECRET`と同じ値にする。未設定の間は認証系アクションとactor付き要求がすべて`Unauthorized`
- `PROXY_SECRET`: プロキシ認証の共有シークレット(Vercelの`GAS_PROXY_SECRET`と同じ値。未設定時は認証なし=移行期間)

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

集計・検索の純粋関数は`test/expense-analysis.test.mjs`で検証します（TypeScriptを直接実行できるNode.js 22.18以降）。
ブラウザー回帰は実データを使わず全明細APIを架空データに差し替えます。
`npm run build`後に`npm run test:e2e`を実行します。テストが一時的なローカルサーバーと
架空のGAS接続先を起動し、実行ごとに生成するパスワード・署名鍵をメモリ内だけで使用して終了時に停止します。
インストール済みChromeを使用し、`PLAYWRIGHT_CHANNEL`でブラウザーを変更できます。
未認証・旧形式・改ざん・期限切れCookieの拒否、正規ログイン、認証前にGASを呼ばないことも検証します。
両sourceの統計・検索・編集・削除・認証と、320×568／390×844／844×390のモーダル操作を検証します。

### デプロイ(`.github/workflows/deploy.yml`)

`main`へのpush(または手動の`workflow_dispatch`)1回で、次の順に実行します。
同時実行は1本に制限します(`concurrency`、実行中のデプロイは取り消さない)。

1. **test**: `npm ci` → `npm test` → `npm run lint` → `npm run build`(Node.js 24)。
2. **gas**(testの成功後):
   - 稼働中のGAS Web Appに`?action=version`を問い合わせ、返ったビルドID(commit SHA)と今回のcommitの間で
     `gas/`に差分がある場合だけデプロイします(ビルドID不明・祖先でない場合もデプロイ。
     `workflow_dispatch`の`force_gas`で強制可)。直前のpushではなく稼働中のビルドと比べるので、
     待機中の実行が後続pushに置き換えられてもGAS変更を取りこぼしません。
   - デプロイ時は`gas/コード.js`の`const GAS_BUILD = 'dev';`をcommit SHAに置換してから
     `clasp push` → 既存デプロイIDへ`clasp deploy`(URLは不変)し、`?action=version`が
     そのSHAを返すことを確認します(最大約1分リトライ)。確認できなければ失敗し、Vercelへは進みません。
   - 問い合わせは`scripts/gas-build.mjs`が行い、応答本文やkeyはログに出しません。
3. **vercel**(test成功かつgasが成功/スキップ): GitHub Environment`production`(Vercel用Secretを保持、承認者なし)で
   `vercel pull --environment=production` → `vercel build --prod` → `vercel deploy --prebuilt --prod`
   (Vercel CLIはバージョン固定)を実行します。

GAS変更とUI変更は同じpushに含めてかまいません(GASの確認後にUIが出ます)。
`main`へのpushがそのまま本番反映になるため、`git push`は必ずユーザーの明示承認後に行います(唯一の承認ゲート)。
docsだけの変更でもVercelへ再デプロイされます。

`?action=version`(doGet)は読み取り専用で`{ "build": "<commit SHA>" }`だけを返し、
プロキシ認証(`PROXY_SECRET`)の対象です。ローカルの`clasp push`では`dev`のままです。

#### ユーザーがGitHub/Vercel側で行う設定

| 種別 | 名前 | 内容 |
| --- | --- | --- |
| Secret | `CLASPRC_JSON` | clasp認証情報(既存) |
| Secret | `GAS_SCRIPT_ID` | Apps ScriptのスクリプトID(既存) |
| Secret | `GAS_DEPLOYMENT_ID` | 既存Webアプリのデプロイ ID(既存) |
| Secret | `GAS_API_URL` | GAS Web AppのURL(Vercelの同名変数と同じ値)。デプロイ判定・確認に使用 |
| Secret | `GAS_PROXY_SECRET` | 任意。GASの`PROXY_SECRET`を有効化している場合は同じ値 |
| Secret | `VERCEL_TOKEN` | Vercelのアクセストークン |
| Secret | `VERCEL_ORG_ID` | Vercelのチーム/ユーザーID(`.vercel/project.json`の`orgId`) |
| Secret | `VERCEL_PROJECT_ID` | VercelのプロジェクトID(`.vercel/project.json`の`projectId`) |
| Environment | `production` | Vercel用Secret(`VERCEL_*`)を保持。Required reviewers は設定しない(2026-11-08 自動化) |
| Vercel | Git連携 | **無効のまま**にする(有効だとpushで並行デプロイされ、GAS→UIの順序が崩れる) |

旧ワークフロー`deploy-gas.yml`は`deploy.yml`に統合して削除しました。

注意:

- 承認ゲートを戻したい場合は、Environment `production` に Required reviewers を設定するだけでよい
  (ワークフローの変更は不要。承認しない実行は放置せず「Reject」する)。

#### ロールバック

- GAS: `npx clasp deployments`/`npx clasp versions`で直前のバージョン番号を確認し、
  `npx clasp deploy -V <前のバージョン番号> -i <デプロイID>`で既存デプロイを戻します(URLは不変)。
  その後`?action=version`で戻ったビルドIDを確認します。次回のpushでは稼働中ビルドとの差分で再デプロイされます。
- Vercel: `npx vercel rollback`(直前の本番デプロイへ)または`npx vercel rollback <デプロイURL>`、
  もしくはダッシュボードで以前のデプロイを「Promote to Production」します。
- UIだけ戻す場合もGAS API契約の互換性(旧UIで動くこと)を確認します。各ラウンドで新GAS+旧UIの組合せを検証済みです。

手元からの緊急デプロイは`npm run gas:push`と`npm run gas:deploy`でも可能です
(要`npx clasp login`と`.clasp.json`。`GAS_BUILD`は`dev`のまま)。
