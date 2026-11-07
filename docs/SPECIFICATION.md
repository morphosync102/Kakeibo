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
| `main`または未指定 | 家庭用 | `/`, `/statistics`, `/calendar`, `/manage` | なし |
| `yahoo` | 個人用 | `/yahoo`, `/yahoo/statistics`, `/yahoo/calendar`, `/yahoo/manage` | `Yahoo_` |

コンポーネント、API、GASの全レイヤーでsource分離を維持します。

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
  - 「この店舗すべて」: 同じ店舗名の既存明細を両sourceで更新し、
    Configにも今後の自動分類ルールとして保存します(2タップ確認)。
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
2. GASエディタから`backfillRowIds()`を1回実行する(Script Lock内でData/Yahoo_Dataを別々に処理し、
   H列が空の行だけ採番、H1が空ならヘッダ`RowId`を書き込み、各sourceのキャッシュを無効化。
   冪等なので再実行しても既存値は変わりません)。
   H列が既に別用途で使われている場合(H1が空でも`RowId`でもない、またはH2以降にUUID以外の値がある)は、
   両シートとも何も書き込まずにエラーで中止します(メッセージはシート名と件数のみ)。
   H列の内容を別の列へ移してから再実行してください。
3. UIをデプロイする(UIはbackfill前でも、旧GASでも動作します)。

シートへ手作業で行を追加した場合は、`backfillRowIds()`を再実行してRowIdを採番します。

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

### GET

- `GET /api/expenses`: 対象sourceの明細一覧
- `GET /api/expenses?source=yahoo`: 個人用明細一覧
- `GET /api/expenses?action=getFixedCosts[&source=yahoo]`: 固定費一覧

`source`はGET/POST共通で、省略・空文字・`main`(家庭用)と`yahoo`(個人用)のみ受理します。
それ以外(`Yahoo`等の表記ゆれを含む)は`{ "error": "Invalid source" }`を返し、何も読み書きしません。
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
| `updateCategory` | 両sourceの同一店舗カテゴリとConfig更新 | merchant, category |
| `addFixedCost` | 対象sourceへ固定費1件追加 | type, name, amount, day, category |
| `deleteFixedCost` | 対象sourceの固定費1件削除。type/name/amount/dayを渡すと照合削除(idの行が一致すればその行、しなければ全行から最初の一致行、なければ`Fixed cost not found`)。idのみなら旧来の行番号指定 | [id], [type, name, amount, day, category] |

GASはJSONで`{ success: true, ... }`または`{ error: "..." }`を返します。
全書き込みactionはScript Lock内で行を読み直して照合してから書き込みます。20秒以内に
ロックを取得できない場合は何も変更せず`{ "error": "Busy" }`を返します(クライアントは失敗として扱う)。
Next.js POSTプロキシは、固定費系actionは`fixedCosts`タグ、それ以外は`expenses`タグを
完了後に再検証します(`revalidateTag(tag, { expire: 0 })`)。

`deleteFixedCost`はUIから`id`と照合フィールド(type/name/amount/day/category)を送ります。

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

`processFixedCosts()`を日次トリガーで実行します。IDは月・名称・sourceから生成し、
同月の重複登録を防ぎます。重複判定と追加はsourceごとにScript Lock内で行い、
ロックは最大120秒待ちます。取得できない回はその日の分が追加されず、翌日のトリガーでも
補完されない(当日日付の行のみ対象のため)ので、警告ログを確認して当日中に再実行または手入力します。

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
| Next.js | `unstable_cache`(`expenses`/`fixedCosts`タグ、クエリ別キー)、5分再検証。GASへの生fetchは`no-store`。`fresh=1`は迂回 | POST完了後に`revalidateTag(tag, { expire: 0 })` |
| GAS | source・data/fixed別Script Cache、6時間 | GAS書き込み成功後に`clearCache(source)` |

GAS Script Cacheはsourceごとの世代トークン`kakeibo_{main|yahoo}_gen`(data/fixed共通、
source省略・空文字は`main`)を持ち、一覧は`<key>_<gen>_chunks`(チャンク数)と
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
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_DESTINATION_MAIN`
- `LINE_DESTINATION_YAHOO`
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

### デプロイ順序

GAS API契約を変更する場合:

1. `gas/コード.js`の変更をコミットし、`main`へpushする(UI変更とは別コミット)。
2. GitHub Actions(`deploy-gas.yml`)が`clasp push`と既存デプロイIDへの
   `clasp deploy`を自動実行するので、成功を確認する。
3. その後、依存するWebアプリの変更をpushし、Vercel本番へデプロイする。
4. 本番で対象操作を確認する。

GAS変更がないWebのみの変更は、Vercelデプロイだけで完了します。
VercelはGitHub連携ではなく手動CLIデプロイ運用です(`npx vercel --prod`)。
pushしただけでは本番に反映されません。
手元からの緊急デプロイは`npm run gas:push`と`npm run gas:deploy`でも可能です
(要`npx clasp login`と`.clasp.json`)。
