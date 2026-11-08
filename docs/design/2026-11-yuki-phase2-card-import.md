# 設計書: フェーズ2 利用者(source `yuki`)のカード明細自動取込(利用者の Gmail → 中継 Apps Script → 家計簿 GAS `ingestEmail`)

- 状態: 設計案(未実装)。2026-11-09 作成、同日改訂(方式変更・公開範囲の見直し・clasp による配置)
- 前提となる設計: [`2026-11-yuki-and-passkeys.md`](2026-11-yuki-and-passkeys.md) §9(フェーズ2概要)・§10。
  同書 §9.2・§9.3 は本書で置き換える。
- 本書の記法: 「要確認」は未検証の前提。実装・初回設定のときに確かめ、結果で本書を直す。
- **公開範囲の方針**: このリポジトリは公開(GitHub)。本書・手順書・中継スクリプトには、利用者が使っているカード会社・携帯会社・メールの具体的な流れ、
  通知の送信元・件名、実在のアドレス・URL・秘密を書かない。**利用者ごとの具体値は、公開しない設定値**(中継スクリプトと家計簿 GAS の Script Properties)
  として扱い、調査メモはリポジトリ外(管理者の非公開の場所)に置く。本書で送信元アドレスに触れるのは、既存コードにある yahoo 用の定数の説明だけ。

## 0. 方式変更の経緯

| 日付 | 内容 |
| --- | --- |
| 2026-11-08 | 前設計書で「利用者の Gmail を NAS が IMAP(アプリパスワード)で読む」と決定(D13) |
| 2026-11-09 | 利用者のカードの利用通知は、Gmail ではなく**携帯会社のメール**に届くと判明。「NAS ワーカーが携帯会社のメールを IMAP で読む」案を作成(未公開の版。採用せず) |
| 2026-11-09 | **ユーザーが方式を変更**: 通知を利用者の Gmail に届くようにし(§3)、**利用者自身の Google アカウントで動く中継用 Apps Script** が読んで家計簿 GAS に送る。NAS もアプリパスワードも使わない |
| 2026-11-09 | 公開リポジトリに利用者の具体が載ることを避けるため、本書とファイル名を一般化 |
| 2026-11-09 | **前提変更(ユーザー承認済み)**: 利用者は PC を持っておらず、スクリプトの貼り付けはできない。**利用者専用の Claude Code セッション(`claude-nas-yuki`)が clasp で利用者の Google アカウントに中継スクリプトを作成・デプロイ**し、利用者の操作は iPhone だけにする。設定値は中継スクリプトの Web アプリ(本人だけが開ける設定フォーム)で利用者が入れる(本改訂) |

変更の主な理由: 旧案(NAS IMAP)では利用者のメールボックス全体に効く認証情報が管理者の NAS に常駐した。新方式では
**利用者のメールに触れる鍵(中継スクリプトへの OAuth の許可)は利用者の Google アカウントの中にだけ存在**し、管理者・NAS・AI は持たない。
例外は導入・更新のときだけ NAS 上に一時的に置く clasp のトークンで、**中継スクリプトの Gmail の許可が存在しない間だけ**置き、Gmail の許可を与える前に削除・取り消す(両者が同時に存在する時間をゼロにする。§4.8、§10.1)。

---

## 1. 目的・スコープ・非スコープ

### 1.1 目的

利用者が使っているカードの利用通知メールを、利用者の家計簿(source `yuki`、シート `Yuki_Data`)へ自動で取り込む。利用者は今、明細を手入力している。

### 1.2 決定事項(ユーザー決定済み)

| # | 決定 |
| --- | --- |
| P1 | カード会社の利用通知が利用者の Gmail に届くようにする(利用者が設定。§3) |
| P2 | 利用者の Google アカウントで動く**中継用 Apps Script**(以下「中継スクリプト」)が利用者の Gmail を読み、本文を家計簿 GAS の新アクション `ingestEmail` へ送る |
| P3 | 家計簿 GAS は取込専用シークレット `INGEST_SECRET` だけで認証し、`yuki` 固定で既存のパーサ・重複判定・RowId 採番・ロックを使って `Yuki_Data` に書く(前設計書 D15) |
| P4 | NAS・アプリパスワードは使わない(取込の経路に NAS は入らない) |
| P5 | 利用者は PC を持たない。**`claude-nas-yuki` が clasp で中継スクリプトを利用者の Google アカウントに作成・デプロイ**し、利用者は iPhone で認可と設定だけを行う。Claude は手順書が許すコマンド(clasp と取得・確認)だけを実行する |
| P6 | `INGEST_SECRET` は管理者が家計簿 GAS の Script Property に設定し、同じ値を利用者に別経路(LINE 等)で渡す。**利用者が中継スクリプトの設定フォームに直接入れる**(Claude には渡さない) |
| P7 | main・yahoo の取込は変えない(前設計書 D14) |

### 1.3 スコープ

- 家計簿 GAS: `ingestEmail`、処理済みメールの記録シート `Ingest_Log`、エディタ関数 `setupIngestSheet`。
- 中継スクリプト: `relay/card-notice-relay.gs`(本体)、`relay/settings.html`(設定フォーム)、`relay/appsscript.json`(スコープと Web アプリ設定を固定)。
  カード会社に依存しない汎用の中身。
- 利用者向け手順書: `docs/guides/card-import-setup.md`(`claude-nas-yuki` が読み、利用者を iPhone で案内し、自分は許されたコマンドだけを実行する)。
- テスト(VM)、導入・更新・停止・ロールバック手順。

### 1.4 非スコープ

- main・yahoo のメール取込(`runEmailExtraction` `gas/コード.js:1345-1349`)。
- 過去分の一括取込。初回は運用開始日以降だけ(§4.4 `START_DATE`)。
- NAS・`claude-nas-yuki` の設定変更(既存のセッションで手順書のコマンドを実行するだけ)。
- IMPROVEMENTS 4-3 の main / yahoo への適用。

---

## 2. 全体構成

```text
 カード会社 ──利用通知──> 利用者のメールボックス (携帯会社のメール等)
                              │ ① 利用者の設定で Gmail に届くようにする(自動転送、または通知先の変更。§3)
                              ▼
                        利用者の Gmail
                              │ ② 中継スクリプト(利用者の Google アカウントで実行、10 分ごとの時間主導トリガー)
                              │    Gmail API を gmail.readonly で検索・取得(書き込み・送信の権限を持たない)
                              ▼
                        UrlFetchApp HTTPS POST {action:'ingestEmail', ingestKey, source:'yuki', message}
                              ▼
                        家計簿 GAS Web App (管理者のアカウントで実行) ── ③ 設定されたパーサ → Yuki_Data (+ Ingest_Log)

 (画面の通り道は従来どおり: 利用者の iPhone → Vercel → 家計簿 GAS → Sheets。①〜③は通らない)

 導入・更新のときだけ:
   利用者の iPhone ──会話──> claude-nas-yuki (NAS 上、利用者専用の Claude Code)
        │                         │ 手順書と中継スクリプトを取得(タグ固定の GitHub、または利用者の共有フォルダ。§6.4)
        │                         │ clasp: login(一時)→ create-script → push → create-deployment → logout
        │                         ▼
        │                    利用者の Google アカウントの Apps Script プロジェクト「家計簿取込」
        └──iPhone の Safari──> ① clasp の認可画面(Google)
                               ② clasp logout(NAS 上のトークン削除)の後、Google アカウントで clasp の許可を取り消す(必須)
                               ③ その後に初めて、中継スクリプトの Web アプリ /exec(本人のみ)を開く:
                                  OAuth 同意(Gmail の読み取り等)→ 設定フォームに INGEST_SECRET・家計簿 GAS の URL・検索条件を入力 → 保存でトリガー作成
   順序の原則: clasp のトークンと中継スクリプトの Gmail の許可を同時に存在させない(更新時は先に Gmail の許可を取り消す。§4.8)
```

- 中継スクリプトや Gmail が止まっても取込が遅れるだけ。閲覧・手入力は従来どおり。再開時は直近 N 日(既定 7 日)を読み直す(§7)。
- 中継スクリプトから外への通信は家計簿 GAS への HTTPS だけ(URL は Script Property、形式を限定)。
- 常時動く部分に NAS は入らない。NAS(`claude-nas-yuki`)は導入・更新のときだけ使う。

### 2.1 責任分界(誰が何の鍵を持つか)

| 鍵・権限 | 持つ人・場所 | 期間 | できること | 持たない人 |
| --- | --- | --- | --- | --- |
| 中継スクリプトへの OAuth の許可(`gmail.readonly` 等の 3 スコープ) | **利用者の Google アカウント内** | 常時 | 利用者の Gmail 全体の読み取り(書き込み・削除・送信はできない)、家計簿 GAS への送信、トリガーの作成 | 管理者・NAS・AI |
| **clasp のトークン**(リフレッシュトークンを含む `~/.clasprc.json`) | `claude-nas-yuki` の home(NAS のデータセット `tam/apps/claude-nas/yuki-home`、所有者 uid 3001、mode 700) | **導入・更新の作業中だけ**(数十分)。**中継スクリプトの Gmail の許可が無い間に限る**。`/exec` での同意より前に `clasp logout` で削除し、利用者が Google 側でも取り消す | 利用者の Apps Script プロジェクトの作成・**コードの書き換え**・デプロイ、clasp が作った Drive ファイルの操作など(スコープは §4.8) | 作業後は誰も持たない |
| 中継スクリプトのコード | 利用者の Apps Script プロジェクト | 常時 | 上の許可の範囲で動く | 管理者は編集できない(共有しない限り)。clasp のトークンがある間は `claude-nas-yuki` が書き換えられる |
| 通知を Gmail に届ける設定 | 利用者 | 常時 | 開始・停止 | 管理者・AI |
| `INGEST_SECRET` | 家計簿 GAS の Script Property(管理者)と中継スクリプトの Script Property(利用者がフォームで入力) | 常時 | `ingestEmail` で**利用者の家計簿に明細を足すことだけ** | NAS・AI・リポジトリ |
| 家計簿 GAS の Web App の URL | 管理者 → 利用者(フォームで入力) | 常時 | `ingestEmail` の送り先 | リポジトリ |
| 利用者ごとの具体値(検索条件、パーサの種類) | 中継スクリプトと家計簿 GAS の Script Properties | 常時 | — | リポジトリ |
| `Yuki_Data` 等のシート | 管理者(スプレッドシートの所有者) | 常時 | 前設計書 D6 のとおり管理者は技術的に明細を見られる(説明済み) | — |

### 2.2 R1(利用者本人の同意)の説明

導入前に、次を利用者に説明して同意を得る(ユーザー側タスク。手順書の 1 章にも同じ内容を載せる)。

1. 通知を Gmail に届ける方法によっては、Gmail に通知以外のメールも入る(例: 自動転送が送信元で絞れない場合は全メール。§3)。元のメールボックスにも残る。
2. 中継スクリプトは利用者自身の Google アカウントで動き、Gmail を**読むだけ**の許可(`gmail.readonly`)で、利用者が設定した検索条件に合うメールだけを読む。
   その許可は利用者のアカウントの中にだけあり、**管理者・NAS・AI は持たない**。
3. **導入・更新のときだけ**、利用者の Claude(`claude-nas-yuki`、NAS 上で動く)が clasp という道具で利用者の Google アカウントにスクリプトを置く。
   そのために利用者は clasp に一時的な許可を与える。この許可があると、**利用者の Apps Script のプロジェクトを作ったり書き換えたりできる**
   (書き換えたスクリプトが利用者の Gmail を読む許可を持っていれば、メールを外へ送るように変えることも技術的にはできる)。
   許可の鍵(トークン)は作業中だけ NAS 上の利用者の Claude の領域に置かれる。**このトークンがある間、中継スクリプトはまだ(更新のときは、いったん取り消して)
   Gmail を読む許可を持たない**。利用者が Gmail を読む許可を与えるのは、トークンを削除し、Google アカウントの画面で clasp の許可を取り消した後だけ。
   NAS の管理者と、管理者が NAS を任せている AI は、作業中の数十分の間であれば技術的にはトークンを使えるが、その間はスクリプトに Gmail を読む許可が無い。
   ただし、その間にスクリプトが書き換えられた場合、後で利用者が許可を与えるとそのコードが動く。そのため許可の前に、置かれたコードが
   管理者から伝えられた版と同じかを確かめる(手順書 8 章の最初の確認)。
4. 置くスクリプトは公開リポジトリ(または管理者が利用者の共有フォルダに置いたファイル)のもので、**利用者の Claude に内容を説明させて確認できる**。
5. 家計簿に送るのは条件に合うメールの本文だけ。家計簿側に残るのは日付・店名・金額の明細と、処理済みの記録(メール ID のハッシュと件数)。本文そのものは保存しない。
6. 管理者から受け取る `INGEST_SECRET` で可能なのは「利用者の家計簿に明細を足す」ことだけ。漏れても利用者のメールは読まれない。
   この値は利用者が設定フォームに自分で入れ、Claude には渡さない。
7. 止め方(§9.4): 設定フォームの「停止」「すべて削除」、Google アカウントの「サードパーティ製のアプリとサービス」から許可の取り消し、転送・通知先の設定の解除。どれも iPhone だけで、すぐにできる。
8. 公開リポジトリには、この仕組み(中継スクリプト・手順書・本書)が載る。利用者のカード会社・携帯会社・アドレスなどの具体は載せない(§10.2 Q9)。

前設計書 R2〜R7 の対応:

| # | 要件 | 新方式での担保 |
| --- | --- | --- |
| R2 | 読み取り専用 | 中継スクリプトの OAuth スコープを `gmail.readonly` に限定(§4.2)。ラベル付け・既読化もしない |
| R3 | 送信元での絞り込み | Gmail の検索条件(利用者がフォームで入れる設定値)。一致したメールだけ本文を取得 |
| R4 | 利用者がいつでも止められる | §2.2 の 7 |
| R5 | 本文を残さない | 中継スクリプトはメモリ上で送るだけ。ログは件数のみ。家計簿 GAS も本文を保存しない。NAS には本文も設定値も来ない |
| R6 | 最小限の接続 | 外への通信は家計簿 GAS の URL だけ(形式を限定) |
| R7 | 取得範囲 | `newer_than:Nd`(既定 7 日)と `START_DATE` より後だけ |

---

## 3. 通知を利用者の Gmail に届ける(利用者の作業)

- 方法は 2 つ。具体的な画面の手順は利用者の契約しだいなので、**手順書には一般的な探し方だけを書き**、利用者が iPhone で自分の画面を確かめる。調査メモはリポジトリ外。
  - (a) 元のメールボックス(携帯会社のメール等)の**自動転送**で Gmail に送る(ユーザー決定の既定)。
  - (b) カード会社の会員サイトで**通知先のアドレスを Gmail に変える**。Gmail に入るのがカード会社のメールだけになり、転送で差出人が変わる心配もない(§10.2 Q2)。
- 自動転送について一般に確認すること(手順書に「確認できなければ中止して管理者へ」と書く):
  - 設定画面に自動転送があるか。送信元で絞れるか(絞れなければ全メールが Gmail に入る。R1 の 1)。
  - 転送後の差出人(From)・Message-ID が元のままか(§4.1 の検索条件と §7 の重複判定に関わる。要確認)。
  - 転送先の登録回数などの制限、必要な暗証番号、Wi-Fi をオフにする等の前提。
- Gmail の迷惑メール判定で通知が「迷惑メール」に入ることがあるので、中継スクリプトは迷惑メールも検索対象に含める(§4.3)。

---

## 4. 中継スクリプト(`relay/`)

### 4.1 検索条件(公開しない設定値)

- Script Property `SEARCH_QUERY`(**必須**、既定値なし)に Gmail の検索式を置く。利用者が設定フォームで入れる。フォームのプレースホルダは
  `from:<カード会社の送信元アドレス> subject:<件名に必ず入る語>`。利用者の具体値はコード・リポジトリ・Claude との会話に出さない。
- 実行時に `newer_than:<LOOKBACK_DAYS>d -in:trash` を必ず付け足す(設定で外せない。範囲の上限を守る)。
- 転送で差出人が利用者自身のアドレスに変わる場合(要確認)は、手順書 4 章の確認で気づき、フォームの説明に従って `from:` の部分を転送元のアドレスに替えるか、本文の語を使う。
- Script Property `SUBJECT_INCLUDES`(任意)があれば、件名にその語を含まないものは本文を取得しない(二重の確認)。

### 4.2 権限(最小スコープ)と Web アプリ設定

- **`GmailApp` は使わない**。`GmailApp.search` 等は `https://mail.google.com/`(削除・送信を含む全権限)を要求する
  (https://developers.google.com/apps-script/reference/gmail/gmail-app の各メソッドの Authorization)。
- 代わりに **Gmail API の拡張サービス(`Gmail`、v1)**を使う。`users.messages.list` / `users.messages.get` / `users.messages.attachments.get` は
  `https://www.googleapis.com/auth/gmail.readonly` で呼べる(https://developers.google.com/gmail/api/reference/rest/v1/users.messages/get)。
- `relay/appsscript.json` でスコープと Web アプリ設定を固定し、自動検出に任せない。clasp の push でこのファイルがそのまま反映される:

```json
{
  "timeZone": "Asia/Tokyo",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "dependencies": {
    "enabledAdvancedServices": [{ "userSymbol": "Gmail", "serviceId": "gmail", "version": "v1" }]
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp"
  ],
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "MYSELF" }
}
```

| スコープ | 同意画面での表示(目安) | 用途 | 外せるか |
| --- | --- | --- | --- |
| `gmail.readonly` | メールの表示 | 通知の検索・取得 | 不可 |
| `script.external_request` | 外部サービスへの接続 | 家計簿 GAS への POST | 不可 |
| `script.scriptapp` | ユーザーが不在のときにこのアプリケーションを実行 | 設定フォームの保存・停止でトリガーを作る・消す | 不可(利用者がエディタでトリガーを作れないため) |

- Web アプリ(`HtmlService`・`google.script.run`)、`PropertiesService`・`CacheService`・`LockService`・`Utilities` は追加スコープ不要の見込み(要確認: 初回の同意画面で確かめる)。
  `MailApp`・Drive・Sheets は使わない。**同意画面にこの 3 項目以外(メールの送信・削除・管理、連絡先、ドライブ等)が出たら許可せず中止**(手順書 8 章)。
- `webapp.executeAs: USER_DEPLOYING`・`access: MYSELF`: Web アプリは利用者本人の権限で動き、**利用者本人(デプロイしたアカウント)以外は開けない**。
- `gmail.readonly` は Google の「制限付きスコープ」なので「このアプリは Google で確認されていません」が出る。自分用のスクリプトなので「詳細」から進んでよいことを手順書に書く。
- 失敗時の通知は Apps Script の「トリガーの失敗通知」(Google から利用者にメール)を使う。送信の権限は要らない。

### 4.3 処理の流れ(`relayRun`、10 分ごと)

1. `LockService.getScriptLock().tryLock(0)`。取れなければ何もしない。
2. Script Properties を読む(§4.4)。必須が欠けている・`KAKEIBO_GAS_URL` が `^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$` に一致しない場合は、固定文言の例外(失敗通知が利用者に届く)。
3. `Gmail.Users.Messages.list('me', { q: <検索式>, maxResults: 50, includeSpamTrash: true })`。
4. 処理済み(`processed`)・保留中(`held`)・`START_DATE` より前(`internalDate`)を除き、古い順に最大 20 通。
5. 各メッセージ: `Gmail.Users.Messages.get('me', id, { format: 'full' })` → ヘッダ(`Subject`・`Message-ID`)と本文パートを取り出す。
   - パートの探索: multipart を再帰でたどり `text/plain` と `text/html` を取る。`message/rfc822` で包まれた転送の中も同じように探す(要確認。§10.3)。
   - 本文の取得: `body.data` があれば base64url を `Utilities.base64DecodeWebSafe` で戻す。大きなパートは `body.attachmentId` だけが返るので
     `Gmail.Users.Messages.Attachments.get('me', id, attachmentId)` で取る(要確認)。
   - 文字コード: パートの `charset` を正規化してから `Utilities.newBlob(bytes).getDataAsString(<名前>)`。
     正規化表: `shift_jis`・`shift-jis`・`sjis`・`x-sjis`・`cp932`・`ms932`・`windows-31j` → `Windows-31J`、`iso-2022-jp`(別名を含む)→ `ISO-2022-JP`、
     `euc-jp`・`x-euc-jp` → `EUC-JP`、`utf-8`・`utf8` → `UTF-8`、指定なし・不明 → `UTF-8`。変換で例外が出たら `UTF-8` で読み直す(0 件なら家計簿 GAS が `noItems` として記録する)。
   - `SUBJECT_INCLUDES` があり件名が含まなければ処理済みにして次へ。
   - `id` = `Message-ID`(山括弧を除き前後の空白を削る)があれば `SHA-256("mid:" + 値)`、無ければ `SHA-256("gmail:" + Gmail のメッセージ ID)`(16 進 64 桁)。
6. `UrlFetchApp.fetch(KAKEIBO_GAS_URL, { method: 'post', contentType: 'application/json', payload, muteHttpExceptions: true, followRedirects: true })`。応答の扱いは §4.5。
7. 1 回の実行は最大 4 分で打ち切る(上限 6 分)。
8. ログは件数と結果コードだけ(`relay ok: matched=2 sent=1 added=1 dup=0 skipped=1 held=0`)。件名・差出人・本文・店名・金額・ID・URL・シークレット・検索式は出さない。
   最後の実行の件数と時刻は Script Property `last_run` にも残し、設定フォームの状態表示に使う(値は件数と時刻だけ)。

### 4.4 Script Properties(中継スクリプト)

| 名前 | 必須 | 内容 | 誰が入れる |
| --- | --- | --- | --- |
| `KAKEIBO_GAS_URL` | ○ | 家計簿 GAS の Web App の URL(形式を限定) | 利用者がフォームで(管理者から受け取る) |
| `INGEST_SECRET` | ○ | 取込専用シークレット | 利用者がフォームで(管理者から別経路で受け取る) |
| `SEARCH_QUERY` | ○ | Gmail の検索式(§4.1。公開しない具体値) | 利用者がフォームで |
| `START_DATE` | ○ | 開始日(`YYYY-MM-DD`)。これより前のメールは送らない | 初回保存時にフォームが当日を入れる |
| `SUBJECT_INCLUDES` | — | 件名に含むべき語 | 利用者がフォームで(任意) |
| `LOOKBACK_DAYS` | — | 何日前まで探すか(既定 7、1〜30) | 通常は入れない |
| `DRY_RUN` | — | `1` で家計簿に書き込まない | フォームの「お試しモード」(初回は既定でオン) |
| `processed` / `held` / `last_run` | (自動) | 処理済み・保留の Gmail ID と時刻、最後の実行の件数(JSON)。古いものは削除 | スクリプト |

- Script Properties は 1 値 9KB・合計 500KB まで。通知は 1 日数通なので数 KB に収まる。
- 処理済みの記録に Gmail のラベルを使わないのは、ラベル付けに `gmail.modify` が要るため(R2)。
- **clasp の push は Script Properties を消さない**(コードと `appsscript.json` だけを置き換える)。更新しても設定は残る(要確認: 初回の更新で確かめる)。

### 4.5 応答ごとの扱い(処理済み・保留・再送)

| 家計簿 GAS の応答 | 中継スクリプトの扱い |
| --- | --- |
| `{success:true, added}` / `{success:true, duplicate:true}` / `{success:true, result:'noItems'}` | `processed` に記録して次へ |
| `{success:true, dryRun:true}` | 記録しない(お試しモードを外した後に本番で送るため) |
| `{error:'Busy'}` / `{error:'RateLimited'}` / HTTP 5xx / 例外 | 記録しない。その回は打ち切り、次の回に再送 |
| `{error:'Unauthorized'}` | 記録しない。その回は打ち切り、**固定文言の例外**(失敗通知)。全メールに共通の原因なので次へ進まない |
| `{error:'Forbidden'}` / `{error:'InvalidMessage'}` / `{error:'TooLarge'}` / 想定外の応答 | そのメールを **`held`(保留)に記録して次のメールへ進む**。回の終わりに `held` が 1 件以上あれば**固定文言の例外を投げ、失敗通知を出し続ける** |

- 保留の解除: 原因を直したあと、利用者が設定フォームの「保留を再送」を押す(`held` を空にする)。保留は `LOOKBACK_DAYS + 7` 日で消える。
- 同じメールを何度送っても、家計簿 GAS の `Ingest_Log` と E 列の重複判定で二重にならない。

### 4.6 設定フォーム(Web アプリ。iPhone で開く)

`doGet` が `HtmlService` で小さなページを返す。利用者は clasp のデプロイ後に Claude から伝えられた `/exec` の URL を iPhone の Safari で開く。

| 項目 | 内容 |
| --- | --- |
| 状態 | 各設定が「設定済み/未設定」、トリガーの有無、お試しモードの有無、最後の実行の時刻と件数(`last_run`)、保留の件数。**値そのものは表示しない** |
| 設定の入力 | `INGEST_SECRET`(パスワード欄)、家計簿の URL、検索条件(必須。プレースホルダ §4.1)、件名の語(任意)、お試しモード(初回は既定でオン)。空欄の項目は変更しない(既存値を保つ。更新後の再開は全欄空欄で保存してよい) |
| 保存して開始 | 入力を検証して Script Properties に保存 → `START_DATE` が無ければ当日 → 既存の `relayRun` トリガーを消して 10 分ごとのトリガーを 1 つ作る(`script.scriptapp`)→ 状態を再表示 |
| 試す | 直近の該当メール 1 通を `dryRun: true` で家計簿に送り、「見つかった通数・解析できた明細数・家計簿の応答コード」だけを表示 |
| 保留を再送 | `held` を空にする |
| 停止 | `relayRun` のトリガーを全部消す(設定は残す) |
| すべて削除 | トリガーを消し、Script Properties をすべて削除する(やめるとき) |

検証と安全策:

- 入力の検証(サーバー側): 家計簿の URL は `^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$`、`INGEST_SECRET` は英数字 32〜128 文字、
  検索条件は 1〜500 文字で `from:` または `subject:` を含む、件名の語は 0〜100 文字。不正なら保存せず、どの欄が不正かだけを返す。
- **保存後に値を返さない**: サーバー関数の戻り値は状態(真偽値・件数・時刻)とエラーの欄名だけ。ページを開き直しても入力欄は空。
- **CSRF 対策**:
  1. **`doPost` を実装しない**。書き込み操作はすべて、`doGet` が返したページの中から `google.script.run` で呼ぶサーバー関数で行う。
     `google.script.run` は Apps Script が配信したページ(Google のサンドボックス iframe)からしか呼べず、他のサイトのフォームから /exec に POST しても何も起きない。
  2. 念のため、`doGet` のたびに乱数のトークンを作って `CacheService.getUserCache()` に 10 分置き、ページに埋め込む。各サーバー関数は一致を確認してから処理する。
  3. `access: MYSELF` なので、利用者本人の Google アカウントでログインしていないと Web アプリ自体が開けない(他人は開けない)。
  4. `HtmlService` の既定の `X-Frame-Options`(他サイトへの埋め込み不可)を変えない(`setXFrameOptionsMode(ALLOWALL)` を使わない。クリックジャッキング対策)。
- ページはスマホ向け(`addMetaTag('viewport', 'width=device-width, initial-scale=1')`、大きいボタン、日本語)。外部の CSS・JS を読まない。
- ログ・例外に入力値を出さない。

### 4.7 停止・削除

- 一時停止: 設定フォームの「停止」。
- やめる: 「すべて削除」→ Google アカウント → セキュリティ → 「サードパーティ製のアプリとサービス」で「家計簿取込」のアクセスを削除 →(必要なら)Apps Script のホーム(script.google.com)でプロジェクトをゴミ箱へ → 転送・通知先の設定を戻す。いずれも iPhone で可能(要確認: script.google.com のプロジェクト削除はスマホで操作しにくい場合がある。残しても許可を取り消せば動かない)。
- 管理者側から止める: 家計簿 GAS の `INGEST_SECRET` を削除(§9.4)。中継スクリプトは失敗通知を出し続けるので利用者にも伝える。

### 4.8 clasp による配置(`claude-nas-yuki` が行う)

| 項目 | 内容 |
| --- | --- |
| 版 | `@google/clasp` **3.4.1**(2026-08-28 公開。公開から 14 日以上たった版に固定)。`npx --yes @google/clasp@3.4.1 …` で実行し、グローバルにインストールしない。kakeibo の devDependencies(`^3.3.0`)とは別 |
| 事前 | 利用者が iPhone で https://script.google.com/home/usersettings を開き「Google Apps Script API」をオン(clasp が API で操作するため) |
| ログイン | `clasp login --no-localhost`。Claude が表示した認可 URL を利用者が iPhone で開いて許可し、表示されたコード(または開けなかったページの URL 全体。clasp 3.x の流れは要確認)を Claude に貼る。認可コードは 1 回限り・短時間で無効になる。Claude はこれを clasp に渡す以外の用途に使わない |
| トークンの保存場所 | `~/.clasprc.json`(`claude-nas-yuki` の `HOME=/home/claude` = NAS のデータセット `tam/apps/claude-nas/yuki-home`、所有者 uid 3001、mode 700。NAS リポジトリ `NAS/AGENTS.md` の Datasets 表) |
| トークンのスコープ | clasp 既定のクライアントのスコープ(clasp README の一覧: `script.deployments`・`script.projects`・`script.webapp.deploy`・`drive.metadata.readonly`・`drive.file`・`service.management`・`logging.read`・`userinfo.email`・`userinfo.profile`・`cloud-platform`。既定ログインがこの全部を要求するかは要確認)。**利用者の全 Apps Script プロジェクトの作成・書き換え・デプロイ**、clasp が作った Drive ファイルの操作、Google Cloud の操作ができる。Gmail のスコープは含まない |
| 作成 | 作業用ディレクトリ `~/kakeibo-relay/<tag>/`(home 内。`share/yuki` には置かない)に手順書と `relay/` を用意し(§6.4)、`clasp create-script --type standalone --title 家計簿取込 --rootDir relay`。`.clasp.json`(scriptId のみ。秘密ではない)はそのディレクトリに残す |
| 反映 | `clasp push --force`(`relay/` の 3 ファイルでプロジェクトの全内容を置き換える)→ `clasp create-deployment --description <tag>`。2 回目以降は `clasp create-deployment --deploymentId <初回の ID> --description <tag>` で同じ URL を保つ。`/exec` の URL は `https://script.google.com/macros/s/<deploymentId>/exec` |
| ログアウト | **`/exec` での同意より前に必ず**: `clasp logout` → `test ! -e ~/.clasprc.json` で削除を確認(README: logout は資格情報を削除するだけで、**Google 側の許可は取り消さない**)→ 利用者が iPhone で Google アカウント →「サードパーティ製のアプリとサービス」から clasp(表示名は要確認)のアクセスを削除 |
| 更新 | ① 利用者が設定フォームで「停止」→ Google アカウントで「家計簿取込」(中継スクリプト)の許可を取り消す(Gmail の許可を先に無くす)→ ② clasp で一時的にログイン → 新しいタグのファイルで push → 同じデプロイ ID に create-deployment → ③ ログアウト・削除確認・Google 側で clasp の取り消し → ④ 利用者が `/exec` を開いて再同意 → 空欄のまま「保存して開始」(Script Properties は残っているのでトリガーだけ作り直す) |

- Script Properties は push で消えない見込みなので、更新後に設定フォームで入れ直す必要は無い(要確認)。
- **時間的に重ならないこと**が主な防御: clasp のトークンがある間は中継スクリプトに Gmail の許可が無く、Gmail の許可がある間は clasp のトークンが無い(NAS 上で削除済み・Google 側で取り消し済み)。
- clasp のトークンがある間に `claude-nas-yuki` 以外(管理者・管理者の AI)がそれを使うには、NAS の管理者権限で yuki-home を読む必要がある(uid 3001・mode 700。
  `truenas_admin` の sudo、または compose の書き換え)。作業時間を短くし、直後に削除・取り消しすることで残るリスクを抑える(§10.1)。
- `yuki-home` のスナップショットの有無は要確認(`tam/apps` は 05:00 の再帰タスクの対象外。`NAS/AGENTS.md`「Data protection」)。スナップショットがあると削除したトークンが残るが、
  Google 側で取り消せば無効になる。**取り消しを必須手順にする**のはこのため。

---

## 5. 家計簿 GAS 側: `ingestEmail`

### 5.1 方針

- 既存の道具を使う: カード通知のパーサ(現行は `parseEmailBody`・`parseVpassEmail`(`gas/コード.js:1482-1485`)・`parseJcbBody`)、
  分類 `determineCategory`(1852 行〜)・`getCategoryMap`、追加 `appendImportedRowsLocked`(1839-1850 行。ロック内で E 列の重複除外・RowId 採番・`clearCache`)、ロック `runWithScriptLock`(516 行〜)。
- **どのパーサを使うかは公開しない設定値**: Script Property `INGEST_PARSER_YUKI` にパーサ名(`rakuten` / `vpass` / `jcb` のいずれか)。
  コードには「パーサ名 → 関数」の対応表だけを置く。未設定・不明な名前は `Forbidden`。
- 既存の yahoo の取込が使う送信元の定数(`VPASS_SEARCH_BASE` `gas/コード.js:1426` 等)は yahoo 用の既存仕様で、本機能は使わない。
- HTML → テキストは家計簿 GAS 側(各パーサの前処理。Vpass 形式は `normalizeVpassText` 1497 行〜)。中継スクリプトは文字コードを戻すだけ。
  `<style>`・`<script>`・`<head>` の中身は `ingestEmail` の前処理でブロックごと除く(既存の関数は変えず、yahoo の挙動を変えない)。
- 転送の前置きは既存のパーサが許容する範囲(SPECIFICATION §5)で読む。足りなければパーサ側を直す(要確認)。
- 時間トリガーの取込(`runEmailExtraction`)には何も足さない。

### 5.2 認証と入口

`doPost`(832 行〜)の分岐:

1. LINE webhook(現状どおり、835 行)。
2. **`params.action === 'ingestEmail'` なら `handleIngestEmail(params)`**(`PROXY_SECRET` の照合 841 行より前)。中継スクリプトに `PROXY_SECRET` を持たせないため。
   - `ingestKey` を Script Property `INGEST_SECRET` と `constantTimeEquals`(161 行〜)で照合。**未設定なら常に `Unauthorized`**。
   - `INGEST_SECRET` が `PROXY_SECRET` / `AUTH_PROXY_SECRET` と同じ値なら `setupIngestSheet()` で警告。
3. 以降は現状どおり。

- `INGEST_SECRET` は `ingestEmail` 以外では使わない。`key`/`authKey` では `ingestEmail` を呼べない。
- ブラウザからは呼べない(`/api/expenses` は POST の action を `WRITE_ACTIONS` に限定。`app/api/expenses/route.ts:141-142`)。
- `yuki` は `requiresActor: true`(`gas/コード.js:50`)だが、`ingestEmail` は時間トリガーと同じ機械の経路として actor 照合を通さない。source を固定し追加以外をしない。SPECIFICATION に明記する。
- 旧 UI と互換(新しい action の追加だけ)。

### 5.3 許可と、申告値の扱い

```js
// 受け付ける source。パーサは Script Property INGEST_PARSER_<SOURCE> で選ぶ(公開しない)。
const INGEST_SOURCES = Object.freeze(['yuki']);
const INGEST_PARSERS = Object.freeze({ rakuten: parseEmailBody, vpass: parseVpassEmail, jcb: parseJcbBody });
```

- `main` / `yahoo` は受け付けない(`Forbidden`)。シート名は `getTargetSheets` で引く。
- 件名の条件は任意の Script Property `INGEST_SUBJECT_INCLUDES_YUKI`(公開しない)。From は検査も記録もしない(転送で変わり得るうえ、具体値を公開できないため)。
- 件名・本文はいずれも**中継スクリプトの申告値**で、`INGEST_SECRET` が漏れたときの防御にはならない。役割は設定ミスの検出だけ。
  漏えい時の被害は「`yuki` の家計簿に偽の明細を足される」ことに限られる(読む・消す・他の家計簿に書くはできない。レート制限と `Ingest_Log` で量と跡を抑える)。

### 5.4 リクエスト

```json
{
  "action": "ingestEmail",
  "ingestKey": "<INGEST_SECRET>",
  "source": "yuki",
  "dryRun": false,
  "message": {
    "id": "<64 桁の 16 進: SHA-256>",
    "receivedAt": "2026-11-09T09:00:00+09:00",
    "subject": "<件名>",
    "text": "<text/plain パート(UTF-8)。無ければ空>",
    "html": "<text/html パート(UTF-8)。無ければ空>"
  },
  "worker": { "name": "card-notice-relay", "version": "<RELAY_VERSION>" }
}
```

- E 列(MessageId)には `gm_<id の先頭 32 桁>`、`Ingest_Log` には 64 桁。`gm_` で始まるので `isMailMessageId`(1583 行〜)とも `manual_`・`fixed_` とも区別できる。
  同じメールの複数明細は同じ MessageId。明細の更新・削除の厳密照合は変えない(AGENTS.md)。
- サイズ上限: `text`・`html` は各 200,000 文字、本文全体は 450,000 文字。超えたら `TooLarge`。1 リクエスト 1 通。

### 5.5 処理

1. 認証 → source → パーサ設定 → 形式(`id` は 64 桁 16 進、`receivedAt` は日時、件名条件)。
2. レート制限: Script Cache で 10 分あたり 60 回まで(`RateLimited`)。
3. パース: `text` → 0 件なら前処理した `html`。1 通 20 明細を超えたら `InvalidMessage`。
4. `dryRun: true` なら `{ success: true, dryRun: true, parsed: n }`(書き込みなし)。
5. `runWithScriptLock` の中で: `Ingest_Log` に同じ `id` があれば `duplicate`(削除した明細を復活させない)。
   無ければ `appendImportedRowsLocked(sheet, rows, 'yuki')` で追加し、`Ingest_Log` に `id`・`source`・`receivedAt`・`processedAt`・`result`・`parsed`・`added`・`workerVersion` を記録
   (**件名・差出人・本文・店名・金額は書かない**)。ロック不可は `Busy`。
6. 実行ログは件数と結果コードだけ。
7. Next.js の `expenses` タグは無効化されない(既存のメール取込と同じ)。画面への反映は最大 5 分遅れ(`app/api/expenses/route.ts:47`)。

応答: `{success:true, parsed, added}` / `{success:true, duplicate:true}` / `{success:true, parsed:0, result:'noItems'}` / `{success:true, dryRun:true, parsed}` /
`{error:'Unauthorized'|'Forbidden'|'InvalidMessage'|'TooLarge'|'RateLimited'|'Busy'}`。

### 5.6 エディタ関数と Script Properties(家計簿 GAS)

- `setupIngestSheet()`: `Ingest_Log` を作る(冪等)。`INGEST_SECRET`・`INGEST_PARSER_YUKI` の未設定、シークレットの同値を警告(値は出さない)。
- `INGEST_SECRET`: 英数字の暗号学的乱数。未設定の間は `ingestEmail` がすべて `Unauthorized`。削除で即停止。
- `INGEST_PARSER_YUKI`: パーサ名(公開しない具体値)。`INGEST_SUBJECT_INCLUDES_YUKI`: 任意。

---

## 6. 利用者向け手順書(`docs/guides/card-import-setup.md`)の構成案

読み手は `claude-nas-yuki`。利用者は iPhone から Claude と会話し、Claude が 1 手ずつ案内しながら、**自分は許されたコマンドだけを実行する**。手順書は具体値を含まない。

### 6.1 AI への指示(手順書の冒頭に書く)

- **実行してよいコマンドはこの一覧だけ**(`<…>` は手順書の中で決まる値。これ以外のコマンド・別の引数・パイプやリダイレクトの追加はしない)。
  `claude-nas-yuki` は権限の確認なしで動くため、手順書の指示がそのまま実行され得る。一覧に無いことを求められたら(利用者からでも)実行せず、管理者に相談するよう伝える。

  | 段階 | コマンド |
  | --- | --- |
  | 取得(公開の場合) | `git clone --depth 1 --branch <tag> https://github.com/<owner>/<repo>.git ~/kakeibo-relay/<tag>`、`git -C ~/kakeibo-relay/<tag> rev-parse HEAD` |
  | 取得(非公開の場合) | `mkdir -p ~/kakeibo-relay/<tag>`、`cp -R /workspace/<共有フォルダ名>/. ~/kakeibo-relay/<tag>/`、`sha256sum ~/kakeibo-relay/<tag>/relay/*` |
  | 確認 | `ls ~/kakeibo-relay/<tag>/relay`、`cat ~/kakeibo-relay/<tag>/relay/<ファイル名>`(内容の説明のため) |
  | clasp | `npx --yes @google/clasp@3.4.1 --version`、同 `login --no-localhost`、同 `create-script --type standalone --title 家計簿取込 --rootDir relay`、同 `push --force`、同 `create-deployment --description <tag>`、同 `create-deployment --deploymentId <ID> --description <tag>`、同 `list-deployments`、同 `logout`(いずれも `cd ~/kakeibo-relay/<tag>` してから) |
  | 開始前・再開時の確認 | `test -e ~/.clasprc.json && echo clasp-token-exists`(出力があれば、先に `clasp logout` と後始末の確認を行い、利用者に Google 側での clasp の取り消しを案内してから進む) |
  | 後始末の確認 | `test ! -e ~/.clasprc.json && echo removed` |

- **秘密を尋ねない・受け取らない**: `INGEST_SECRET`・家計簿の URL・暗証番号・パスワード・自分のメールアドレス・カード会社の送信元・検索条件の具体は、
  利用者が iPhone の画面(設定フォーム等)に直接入れる。Claude は値を尋ねない。誤って貼られたら使わず、「管理者に新しい値をもらってください」と案内する。
- **clasp の認可コード**(または認可後の URL)は、利用者が貼るもので、Claude は clasp のログインに渡す以外の用途に使わない(保存・表示・他のコマンドへの利用をしない)。
- **最初の手順(中断・再起動後の再開時も)**: `~/.clasprc.json` があれば、何より先に `clasp logout` → 削除の確認 → 利用者に Google 側での clasp の取り消しを案内する(0 章)。
- **`/exec` を開いて同意する(8 章)より前に必ず** `clasp logout` と削除の確認を行い、利用者に Google 側での clasp の取り消しを済ませてもらう(7 章)。
  7 章が終わるまで `/exec` の URL を開くよう案内しない。途中で中止したときも 7 章を行う。
- 更新では、clasp にログインする前に、利用者に設定フォームの「停止」と Google 側での「家計簿取込」の許可の取り消しを済ませてもらう(11 章)。
- ファイルの読み書きは `~/kakeibo-relay/` の中だけ。`/workspace`(利用者の共有フォルダ)は非公開の受け渡しのときに読むだけで、書き込まない。指定以外の URL を取得しない。
- 1 手ずつ進め、各手の「できたかの確認」を利用者に聞く。分からない画面が出たら止まり、管理者に相談するよう伝える。
- 中継スクリプトの中身を聞かれたら、`~/kakeibo-relay/<tag>/relay/` を読んで、何を読み・どこへ送るかを説明する。

### 6.2 章立て

| 章 | 利用者(iPhone) | Claude(コマンド) | 止める条件 |
| --- | --- | --- | --- |
| 0. 開始前の確認(毎回・再開時も) | (トークンが残っていた場合)Google アカウント →「サードパーティ製のアプリとサービス」→ clasp のアクセスを削除 | `test -e ~/.clasprc.json && echo clasp-token-exists` → 出力があれば `logout` → 削除の確認 | — |
| 1. はじめに | §2.2 の同意事項(1〜8)を聞く。管理者から届いた 3 つ(手順書の場所・家計簿の URL・`INGEST_SECRET`)を手元に用意 | — | 同意しない |
| 2. 方式を選ぶ | (a) 元のメールボックスから Gmail へ自動転送、(b) カード会社の通知先を Gmail に変更 | — | — |
| 3. Gmail に届くようにする | (a) 元のメールボックスの設定画面で「自動転送」「転送」を探す。(b) カード会社の会員サイトで通知先の変更を探す | — | **見つからない・設定できなければ中止して管理者へ** |
| 4. Gmail で確認 | 通知(またはテストメール)が Gmail アプリに届くか。差出人が元の送信者のままか、自分のアドレスに変わるかを 2 択で答える(アドレスは書かない) | — | 届かない |
| 5. スクリプトの用意 | — | 取得(§6.4 の (a) か (b))→ タグのコミット(またはハッシュ)が管理者から伝えられた値と一致するかを確認 → 内容を説明 | 一致しない |
| 6. clasp で配置 | script.google.com/home/usersettings で「Google Apps Script API」をオン → Claude が示す認可 URL を Safari で開いて許可 → 表示されたコード(または URL)を Claude に貼る | `--version` → `login --no-localhost` → `create-script` → `push --force` → `create-deployment` → `list-deployments` でデプロイ ID を控える(`/exec` の URL は**まだ開かせない**) | 認可画面で clasp 以外のアプリ名が出る / エラー(エラーで止めるときも 7 章へ) |
| 7. 後始末(必須。8 章より前) | Claude の案内で Google アカウント → セキュリティ →「サードパーティ製のアプリとサービス」→ clasp のアクセスを削除し、削除できたことを Claude に伝える | `logout` → 削除の確認 → 取り消しの完了を聞いてから `/exec` の URL を利用者に伝える | 取り消しが済むまで 8 章へ進まない |
| 8. 許可と設定 | (最初に Claude が、置いたコードが管理者から伝えられた版と同じであることを 5 章の照合結果で再確認)`/exec` を Safari で開く →「権限を確認」→「このアプリは Google で確認されていません」→「詳細」→「(安全ではないページ)に移動」→ **「メールの表示」「外部サービスへの接続」「ユーザーが不在のときにこのアプリケーションを実行」の 3 項目だけなら許可。メールの送信・削除・管理や他の項目が出たら許可せず中止** → 設定フォームに LINE で届いた値と検索条件を入れ、お試しモードのまま「保存して開始」→「試す」で「解析できた明細数」が 1 以上(直近に通知が無ければ 0 で、次の利用後に再確認) | — | 同意画面の項目が違う / `Unauthorized` |
| 9. 本番にする | フォームでお試しモードを外して保存 → 次にカードを使ったら 10〜15 分で家計簿に出ることを確認 | — | — |
| 10. 止め方・やめ方 | §4.7 を利用者向けの言葉で(iPhone だけでできる) | — | — |
| 11. 困ったとき・更新 | 失敗通知が来たら(`Unauthorized`・保留は管理者へ)/ 明細が出ない / **更新**: ① フォームで「停止」→ Google アカウントで「家計簿取込」の許可を取り消す → ② 0・5・6・7 章(新しいタグ)→ ③ `/exec` を開いて再同意 → 全欄空欄のまま「保存して開始」(設定は残っている) | 0・5・6・7 章のコマンド(① の取り消しが済んだと聞いてから `login`) | ① が済むまで clasp にログインしない |

- **7 章(clasp の後始末と取り消し)は必ず 8 章(Gmail の許可)の前**。clasp のトークンと Gmail の許可を同時に存在させないため。途中で中止した場合も 7 章は必ず行う。

### 6.3 iPhone だけでできるか

- clasp の認可・Apps Script API のオン・Web アプリの同意と設定フォームは、いずれも Safari の通常のページで、スマホで操作できる見込み(要確認: 管理者が事前に試す。§9.1)。
- 注意: Safari で複数の Google アカウントにログインしていると、`access: MYSELF` の Web アプリが「開けません」になることがある(要確認)。その場合はプライベートブラウズのタブで利用者のアカウントだけにログインして開く、と手順書に書く。
- エディタ(script.google.com のコード画面)は使わない。プロジェクトの削除だけはエディタ側の操作になる(§4.7。残しても許可を取り消せば動かない)。

### 6.4 手順書と中継スクリプトの受け渡し(リポジトリの公開・非公開の両方に対応。§10.2 Q9)

| | (a) リポジトリが公開のまま | (b) リポジトリを非公開にする |
| --- | --- | --- |
| 置き場所 | GitHub のレビュー済みタグ(例 `relay-v1`) | 管理者が手順書と `relay/` の 3 ファイルを、利用者の共有フォルダ(`share/yuki` の中の受け渡し用フォルダ)に置く。**管理者の Claude は `share/yuki` に書けない**(利用者専用の ACL。`NAS/AGENTS.md`「Users and sharing」)ので、管理者が iPhone の「ファイル」アプリ(SMB)や Mac の Finder で置く |
| 管理者が利用者に伝えるもの | タグ名とそのコミットのハッシュ(LINE 等) | フォルダ名と 3 ファイルの SHA-256(LINE 等) |
| 利用者の Claude の取得 | `git clone --branch <tag>` → `rev-parse HEAD` が伝えられたハッシュと一致するか | `cp -R` で home にコピー → `sha256sum` が伝えられた値と一致するか |
| 利用者の Claude への伝え方 | 「手順書は `<repo>` の `<tag>` の `docs/guides/card-import-setup.md`」 | 「手順書は共有フォルダの `<フォルダ名>/card-import-setup.md`」 |
| 備考 | 手順書・コードは誰でも読める(具体値は含まない) | `share/yuki` は利用者のファイルなので、利用者と利用者の Claude が書き換えられる。ハッシュ照合で管理者が置いたものと同じかを確かめる |

---

## 7. 冪等性と障害時の挙動

柱は 3 つ: ① 家計簿 GAS の `Ingest_Log` ② E 列の重複除外(既存)③ 中継スクリプトの `processed`(成功応答のときだけ記録)。

| 事象 | 挙動 | 復旧 |
| --- | --- | --- |
| 家計簿 GAS の停止・`Busy`・5xx | 記録せず次の回に再送 | 自動 |
| 中継スクリプトのトリガーが止まった | 取込が止まるだけ | 再開時に `LOOKBACK_DAYS` 分を読み直す。超えた分は手入力 |
| Gmail に届かなくなった | 取り込まれない | 利用者が設定し直す |
| 迷惑メールに入った | `includeSpamTrash` で拾う | 自動 |
| `Unauthorized` | その回で止まり、毎回失敗通知 | 管理者が新しい値を渡し、利用者がフォームで入れ直す |
| `Forbidden`・`InvalidMessage`・`TooLarge` | そのメールは保留、後続は処理。失敗通知は保留が残る間出続ける | 原因を直してフォームの「保留を再送」 |
| 形式変更(`noItems`) | 処理済みとして進む(件数はログ) | パーサを直す → `Ingest_Log` の該当行を消す → 利用者の再送手段は後続課題(§10.4)。7 日以内の分は手入力 |
| 許可の取り消し・再認証が要る | トリガーが失敗し失敗通知 | 利用者が `/exec` を開いて許可し直す |
| 同じ通知が 2 回届いた | Message-ID が同じなら `duplicate`。無い・変わる場合は二重計上の可能性 | 画面で 1 件消す(要確認: 転送で Message-ID が保たれるか) |
| clasp の作業が途中で止まった(通信断・セッション終了・コンテナ再起動) | トークンが home に残る。中継スクリプトにはまだ Gmail の許可が無い(7 章前のため) | 次のセッションで 0 章(トークンがあれば logout・削除確認・Google 側の取り消し)を最初に行ってから再開 |
| 更新の途中で止まった | 更新の手順では先に Gmail の許可を取り消しているので、新旧どちらのコードも Gmail を読めない(取込は止まる) | 0 章から再開し、7 章まで終えてから `/exec` で再同意 |

---

## 8. テスト計画

### 8.1 家計簿 GAS(`test/gas-ingest-email.test.mjs`、既存 `test/gas-vpass-import.test.mjs` と同じ VM サンドボックス方式)

- 認証: `INGEST_SECRET` 未設定・誤り・欠落 → `Unauthorized`。`key` だけでは呼べない。`ingestKey` で他の action を呼べない。分岐順。
- source: `yuki` 以外 → `Forbidden`。`Data`・`Yahoo_Data` に書かれない。
- パーサ設定: `INGEST_PARSER_YUKI` 未設定・不明 → `Forbidden`。3 種それぞれで架空の本文が解析される。
- 形式・上限: `id` 不正・件名条件外 → `InvalidMessage`。サイズ超過 → `TooLarge`。21 明細 → `InvalidMessage`。
- パース: `text`、`html` のみ(`<style>` 入り)、転送の前置き付き、0 件 → `noItems` 記録。架空の本文のみ使う。
- 追加: `Yuki_Data` の A〜H(RowId は UUID、MessageId は `gm_` + 32 桁)、`Yuki_Config` で分類、`clearCache('yuki')` のみ。
- 冪等: 同じ `id` → `duplicate`。行を消して再送 → 追加されない。`dryRun` → 何も書かない。ロック不可 → `Busy`。レート上限 → `RateLimited`。
- ログ: `console.*` に本文・店名・金額・シークレットが出ない。既存テストが通ること。

### 8.2 中継スクリプト(`test/relay-card-notice.test.mjs`、VM サンドボックス)

`relay/card-notice-relay.gs` を VM に読み込み、`Gmail.Users.Messages.list/get`・`Gmail.Users.Messages.Attachments.get`・`UrlFetchApp.fetch`・`PropertiesService`・
`CacheService`・`LockService`・`ScriptApp`・`HtmlService`・`Utilities`(`base64DecodeWebSafe`・`newBlob().getDataAsString(charset)` は Node の `Buffer` と `TextDecoder` で偽装)・`console` を偽物にする。

取込の本体:

- 権限(R2): `relay/appsscript.json` の `oauthScopes` が §4.2 の 3 つだけ、`webapp` が `USER_DEPLOYING`・`MYSELF`。ソース(`.gs` と `.html`)に `GmailApp`・`MailApp`・`DriveApp`・`SpreadsheetApp`・
  `Gmail.Users.Messages.modify`/`trash`/`delete`/`send`/`insert`/`import`・`Gmail.Users.Labels`・`Gmail.Users.Drafts`・`setXFrameOptionsMode`・外部の `<script src>`/`<link href>` が出現しない(静的検査)。
- 具体値を含まない: ソースにメールアドレスの形の文字列や特定のカード会社名が無い(静的検査)。
- 検索式: `SEARCH_QUERY` 未設定で送らずに例外。`newer_than:7d -in:trash` が必ず付く。`includeSpamTrash: true`。
- 範囲: `START_DATE` より前・処理済み・保留中は取得しない。1 回 20 通まで。古い順。
- 本文: multipart の入れ子、`message/rfc822` で包まれた形、`attachmentId` だけが返る大きなパート。
- 文字コード: 正規化表、ISO-2022-JP・Windows-31J・EUC-JP・UTF-8 の架空本文、不明な名前と変換例外で UTF-8 にフォールバック。
- ID: `Message-ID` の正規化と SHA-256、無いときの Gmail ID 由来。
- 応答の扱い: §4.5 の表を表駆動で。`Forbidden` 等の後も次を処理し回の終わりに例外。`Unauthorized` で即打ち切り。`dryRun` は記録しない。
- ログ・例外の文言: 件名・本文・店名・金額・ID・URL・シークレット・検索式が出ない。`last_run` は件数と時刻だけ。

設定フォーム(Web アプリ):

- **エスケープ**: `relay/settings.html` が HtmlService テンプレートのエスケープなし出力 `<?!= ?>` を使わず、値は `<?= ?>`(自動エスケープ)かクライアント側の `textContent` で表示すること(静的検査。`innerHTML` への代入も無いこと)。
- `doGet`: HTML を返す。状態は「設定済み/未設定」だけで、Script Properties の値(シークレット・URL・検索条件)がページの HTML に含まれない。トークンが `CacheService.getUserCache()` に置かれ、ページに埋め込まれる。viewport の meta がある。
- **`doPost` が定義されていない**(静的検査)。
- 保存(`google.script.run` から呼ぶサーバー関数): トークン不一致・期限切れで拒否。URL の正規表現(`http:`・別ホスト・別パス・クエリ付き・末尾の余分を拒否)、
  `INGEST_SECRET` の文字種と長さ、検索条件の必須と `from:`/`subject:`、長さの上限。不正なら何も保存せず欄名だけを返す。空欄は既存値を保つ。
- **保存後に値を返さない**: 戻り値と例外に入力値が含まれない(全サーバー関数の戻り値を検査)。
- トリガー: 保存で `relayRun` の時間主導トリガーがちょうど 1 つになる(既存を消してから作る。2 回保存しても 1 つ)。「停止」で 0 になり設定は残る。「すべて削除」でトリガー 0・Script Properties が空。
- `START_DATE` が無ければ当日が入り、あれば変えない。お試しモードの切り替えで `DRY_RUN` が付く・消える。
- 「試す」: `dryRun: true` で 1 通だけ送り、件数と応答コードだけを返す。「保留を再送」で `held` が空になる。

### 8.3 結合(ユーザー環境)

1. 家計簿 GAS を push(承認後)→ `setupIngestSheet()` → `INGEST_SECRET`・`INGEST_PARSER_YUKI` 設定。
2. **管理者のリハーサル**: 管理者が自分の Google アカウントで、§6 の 0・5〜8 章を管理者の Claude(`claude-nas`)と管理者の iPhone で通す(clasp の `--no-localhost` の流れ、
   同意画面の 3 項目、設定フォーム、複数アカウント時の挙動、logout と Google 側の取り消し)。検索条件は管理者の Gmail にある同じ形式の通知に向け、
   **お試しモードのまま**「試す」で解析できた明細数が 1 以上になることを確かめる(書き込みはしない)。確認後「すべて削除」→ 許可の取り消し → プロジェクトを削除。
3. 利用者の導入(§9.2)。お試しモードで確認 → 外す → 次の利用で `Yuki_Data` に入る → 二重にならない。
4. 停止系: 「停止」で止まる。管理者が `INGEST_SECRET` を一時的に変えると失敗通知が届く(事前に伝える)。
5. 更新: 11 章の順(停止 → 中継スクリプトの許可の取り消し → 0・5・6・7 章 → 再同意 → 空欄で保存)で、`/exec` の URL が変わらないこと・設定が残ること・トリガーが 1 つに戻ること・**clasp のトークンがある間に中継スクリプトの許可が無い**(Google アカウントの一覧に両方が同時に出ない)ことを確認。

---

## 9. 導入手順とロールバック

### 9.1 管理者(事前)

| # | 作業 |
| --- | --- |
| 1 | 家計簿 GAS のコミット(§11 G-I1)と、中継スクリプト・手順書のコミット(§11 R-1)をレビュー → ユーザー承認 → push。(a) ならタグを付けて push |
| 2 | GAS エディタで `setupIngestSheet()`。Script Property `INGEST_PARSER_YUKI`(と任意で件名の語)を設定 |
| 3 | Mac で `openssl rand -hex 32 \| pbcopy` → `INGEST_SECRET` に貼る |
| 4 | §8.3 の 2(リハーサル)。結果で手順書を直してから利用者の導入へ |
| 5 | (b) の場合: 手順書と `relay/` を利用者の共有フォルダに置き、SHA-256 を控える |
| 6 | 利用者に §2.2 の内容を説明して同意をもらう |
| 7 | 利用者に LINE で送る: ① 手順書の場所(タグとコミットのハッシュ、または共有フォルダ名と SHA-256)② 家計簿の URL ③ `INGEST_SECRET`。送った後 `pbcopy < /dev/null`。利用者がフォームに入れ終えたら ② ③ のメッセージを双方で削除(送信取消) |

- `INGEST_SECRET` を LINE で送ると、取消までの間トーク履歴に残る。漏れても被害は yuki への偽明細の追加に限られ、値を変えれば止まるため許容する(対面でも可)。

### 9.2 利用者(`claude-nas-yuki` の案内で、iPhone だけ)

1. 利用者が `claude-nas-yuki` に「家計簿のカード取込を設定したい。手順書は <場所>」と伝える(LINE で届いた ① をそのまま)。
2. Claude が手順書 0〜9 章の順に案内し、0・5・6・7 章では許されたコマンドだけを実行する(7 章の clasp の後始末と取り消しを、8 章の `/exec` での同意より前に必ず終える)。② ③ は利用者が設定フォームに直接入れる(Claude には渡さない)。
3. 9 章まで終わったら、利用者が管理者に「設定できた」と伝える。管理者は `Ingest_Log` の件数で確認する。

### 9.3 更新

管理者が新しいタグ(または共有フォルダの新しいファイルと SHA-256)を利用者に伝える → 利用者が Claude に「中継スクリプトを更新したい」と頼む → 手順書 11 章の順:

1. 利用者が設定フォームで「停止」→ Google アカウントで「家計簿取込」(中継スクリプト)の許可を取り消す(Gmail の許可を先に無くす)。
2. Claude が 0 章 → 5 章(新しいタグの取得と照合)→ 6 章(clasp でログインして push・`create-deployment --deploymentId` で同じ URL に反映)。
3. 7 章: `clasp logout` → 削除の確認 → 利用者が Google 側で clasp の許可を取り消す。
4. 利用者が `/exec` を開いて再同意 → 全欄空欄のまま「保存して開始」(Script Properties は残っているので、トリガーだけ作り直す)。

更新の間(1〜4)は取込が止まる。止まっていた分は、再開後に `LOOKBACK_DAYS` の範囲から追いつく。

### 9.4 停止・ロールバック

| 何を止める・戻す | 誰が | 手順 | 影響 |
| --- | --- | --- | --- |
| 取込を止める(家計簿側) | 管理者 | GAS の `INGEST_SECRET` を削除(再デプロイ不要) | 以後 `Unauthorized`。利用者に失敗通知が届くので先に伝える |
| 取込を止める(利用者側) | 利用者 | 設定フォームの「停止」 | すぐ止まる |
| メールへのアクセスを消す | 利用者 | 「すべて削除」→ Google アカウントで「家計簿取込」の許可を取り消す | 中継スクリプトは動かなくなる |
| clasp の許可を消す | 利用者 | Google アカウントで clasp の許可を取り消す(導入・更新の 7 章で必ず。`/exec` での同意より前) | NAS 上にトークンが残っていても無効 |
| 転送・通知先を戻す | 利用者 | 元のメールボックス・カード会社の設定 | Gmail に届かなくなる |
| 中継スクリプトを前の版に戻す | 利用者(Claude の案内) | 前のタグで §9.3 の 1〜4 | — |
| 家計簿 GAS のコード | 管理者 | `npx clasp deploy -V <前の版> -i <deploymentId>`(SPECIFICATION §8)。`ingestEmail` は追加だけなので通常不要 | 旧 UI・新 UI とも影響なし |
| 取り込んだ明細 | 利用者 / 管理者 | 画面から削除(`Ingest_Log` があるので復活しない) | — |

### 9.5 `INGEST_SECRET` の差し替え

管理者が新しい値を GAS に設定 → 利用者に別経路で渡す → 利用者が設定フォームで入れ直す(他の欄は空欄のままでよい)。その間の取込は `Unauthorized` で記録されず、差し替え後の回で追いつく。

---

## 10. リスクと未決事項

### 10.1 リスク

| リスク | 影響 | 対策 |
| --- | --- | --- |
| **clasp のトークンが作業中 NAS 上にある** | 利用者の Apps Script プロジェクトを書き換えられる。NAS の管理者・管理者の AI は管理者権限を使えばその間トークンを読める。ただし**その間、中継スクリプトに Gmail の許可は無い**ので、トークンで直接メールは読めない。残るのは「作業中にコードを書き換えられ、後で利用者が許可を与えるとそのコードが動く」経路 | **トークンと Gmail の許可を時間的に重ねない**: 導入は 7 章(logout・削除確認・Google 側で clasp の取り消し)を 8 章(`/exec` での同意)より前の必須手順にし、更新は先に中継スクリプトの許可を取り消してから clasp を使う。8 章の最初に、置いたコードが伝えられた版と同じかを照合結果で確かめる(確かめられるのは NAS 上の配置予定ファイルまでで、Google 上のプロジェクトの中身は作業中の Claude を信頼する)。保存場所は uid 3001・mode 700 の home(`share/yuki` には置かない)。0 章で残ったトークンを最初に片付ける。R1 の 3 で説明 |
| clasp の既定スコープが広い(`cloud-platform`・`script.projects` 等) | トークンが漏れた場合の影響が中継スクリプト以外にも及ぶ(利用者の他の Apps Script・Google Cloud) | 同上(短時間・取り消し)。`--use-project-scopes` など狭める方法が使えるかは要確認(§10.3)。利用者が他に Apps Script・Google Cloud を使っていないかを確認 |
| clasp の認可コードが会話に入る | 会話の記録(`claude-nas-yuki` の home)に残る | 認可コードは 1 回限り・短時間で無効。Claude は他の用途に使わない |
| `claude-nas-yuki` が権限確認なしで動く(bypassPermissions) | 手順書や利用者の会話の誘導で想定外のコマンドが実行される | 手順書に実行してよいコマンドを列挙する。ただし**このコマンド一覧は bypassPermissions の下では強制力のない指示**で、Claude が従わなければ止められない。**実際の防御は、clasp のトークンと Gmail の許可が時間的に重ならないことと、Google 側での clasp の取り消し**(トークンが残っても無効になる)。手順書と中継スクリプトはタグ固定・ハッシュ照合 |
| 自動転送が送信元で絞れない | 通知以外のメールも Gmail に入る | R1 で説明。嫌なら通知先の変更(§3 (b)) |
| 転送で From・Message-ID・本文が変わる | 検索で見つからない/重複判定が効かない | 検索条件を設定値に。Message-ID が無ければ Gmail ID。手順書 4・8 章で確認 |
| `gmail.readonly` は Gmail 全体を読める | 中継スクリプトのコードが悪意あるものに替わるとメールが外へ出る | コードを変えられるのは利用者と(作業中だけ)clasp。同意画面の 3 項目を確認。送信先は家計簿 GAS の URL 形式に限定。コードはタグ固定・ハッシュ照合 |
| 設定フォームの悪用(CSRF 等) | 他サイトから設定を書き換えられる | `doPost` なし、`google.script.run` + トークン、`access: MYSELF`、埋め込み不可、保存後に値を返さない |
| 公開リポジトリのコード・手順書の改ざん | 配置するコードや Claude の案内に悪意ある内容が入る | タグ固定とハッシュ照合、手順書のコマンド一覧、main への push はユーザー承認のみ |
| 利用者の具体が公開される | プライバシー | 一般化、具体値は Script Properties とリポジトリ外。既存の公開記述は Q9 |
| `INGEST_SECRET` の漏えい | yuki に偽明細を足される | 影響は追加のみ。レート制限、`Ingest_Log`、差し替え |
| 「確認されていないアプリ」の警告(中継スクリプト) | 導入が止まる | 手順書で事前に説明。同意画面の 3 項目を確認させる |
| `noItems`(形式変更) | 取込漏れ | 同じパーサを使う既存の取込でも同時に気づける |

### 10.2 ユーザーに確認したいこと

1. **Q1** 利用者のメールの契約の種類(回線契約のメールか、解約後に持ち出したメールか)で自動転送の画面が違います。どちらか分かりますか?(具体名は本書に書きません)
2. **Q2** 「元のメールボックスから Gmail へ自動転送」(ユーザー決定)と「カード会社の通知先を Gmail に変更」のどちらにしますか? 利用者に選んでもらう形でよいですか?
3. **Q3** 通知の件名に、毎回同じ語(検索に使える語)が入っていますか?(利用者のメールで確認。本書には書きません)
4. **Q5** 中継スクリプトの時間主導トリガーを設定フォームの保存で作る(`script.scriptapp` の許可が要る)形でよいですか?(エディタを使わないため、これ以外の方法はありません)
5. **Q6** `INGEST_SECRET` と家計簿の URL を LINE で送り、フォームに入れ終えたら送信取消する運用でよいですか?
6. **Q7** §2.2 の説明(1〜8。とくに 3 の clasp のトークンの説明)を、この文面のまま利用者に説明してよいですか?
7. **Q8** 取込の開始日は導入日からでよいですか?
8. **Q9(公開範囲と受け渡し)** 次をまとめて決めてください:
   - リポジトリを (a) 公開のまま(手順書・中継スクリプトはタグ固定の GitHub から取得)にするか、(b) 非公開にする(管理者が利用者の共有フォルダに置く。§6.4)か。
     (b) の場合、利用者の Claude は GitHub に接続しない。
   - 利用者が、公開リポジトリに載る範囲(仕組み・手順書・中継スクリプト。具体値は載せない)を了承しているか。
   - 既に GitHub に push 済みの、利用者の通知の種類が読み取れる記述(SPECIFICATION §5 の該当節の転送の注意書き、`gas/コード.js:1528-1531` の `parseVpassBody` のコメント)を一般化するか。push 済みの履歴は残る。
   - (解決済み)具体を含む旧案は公開前に履歴から除いた。
9. **Q10** clasp のトークンが導入・更新の作業中(数十分)だけ NAS 上の利用者の Claude の領域に置かれること(§10.1 の 1 行目)を許容しますか?その間、中継スクリプトには Gmail を読む許可が無く(導入では同意の前、更新では先に取り消す)、Gmail の許可がある間はトークンは存在しません(NAS 上で削除済み・Google 側で取り消し済み)。残るのは「作業中にコードが書き換えられ、後の同意でそれが動く」経路です。同意の前の照合で確かめられるのは配置するつもりのファイル(NAS 上)までで、Google 上のプロジェクトに実際に push された中身は作業中の Claude を信頼することになります(iPhone だけでは確かめる手段が見当たらないため)。許容しない場合、iPhone だけで配置する手段は見当たらず、PC を一時的に借りて script.google.com で貼る方法(旧案)に戻ります。

(旧 Q4「PC で作業する前提でよいか」は、利用者が PC を持たないことが分かり、本改訂の方式で解決したため削除。)

### 10.3 実装・初回設定時に確認すること(質問ではない)

- 自動転送の仕様(送信元で絞れるか、転送後の From・Message-ID・本文の前置き)。
- Gmail API の本文: `body.data` の文字コード、`attachmentId` だけが返る大きな本文、`message/rfc822` で包まれた転送メールのパート構造。
- **clasp 3.4.1**: `login --no-localhost` の実際の流れ(コードを貼るのか、リダイレクト先の URL 全体を貼るのか)、既定ログインのスコープの一覧、
  `--use-project-scopes` 等でスコープを狭められるか、`create-script`・`create-deployment --deploymentId` の書式、`logout` が Google 側の許可を取り消さないこと、
  Google アカウントの「サードパーティ製のアプリとサービス」での表示名。
- push で Script Properties が消えないこと。トリガーが HEAD のコードとデプロイ済みの版のどちらで動くか。
- Web アプリ: `executeAs: USER_DEPLOYING`・`access: MYSELF` で、API でデプロイした直後に本人が `/exec` を開いたとき同意画面が出るか、
  同意画面の項目が 3 つだけか(Web アプリのために追加のスコープが出ないか)、Safari で複数の Google アカウントにログインしているときの挙動。
- iPhone の Safari で script.google.com/home/usersettings を操作できるか。
- 未確認アプリの警告の表示と、同意画面の 3 項目の実際の文言。
- 利用者が Google の**高度な保護機能プログラム**に登録している場合、未確認アプリの Gmail スコープは拒否される(登録していれば本方式は使えない)。
- **未確認アプリの許可の期限切れ**の有無。要るなら手順書 11 章に「失敗通知が来たら `/exec` を開いて許可し直す」を明記。
- `claude-nas-yuki` から npm レジストリと GitHub(公開の場合)へ接続できるか。`yuki-home` のスナップショットの有無。
- 個人アカウントの Apps Script の割当(10 分ごと = 144 回/日の実行と UrlFetch)。

### 10.4 後続課題(今回は作らない)

- 取込直後の Next.js `expenses` タグの無効化(最大 5 分遅れ)。
- 設定フォームに「処理済みの記録を消して再送」(形式変更後の取り直し用)。
- yuki 用の「手入力行と一致したらスキップ」(過去分を取り込むとき)。足す場合は `isMailMessageId` が `gm_` で始まる MessageId もメール由来として扱うよう広げる。
- main / yahoo への `Ingest_Log` 方式の展開(IMPROVEMENTS 4-3)。

---

## 11. 作業分割

規模: S = 半日以内、M = 1 日程度、L = 2〜3 日。各コミットで `npm test` / `npm run lint` / `npm run build`。GAS は kakeibo-gas SKILL の手順。push はユーザー承認後。

| # | 内容 | 規模 |
| --- | --- | --- |
| G-I1(家計簿 GAS コミット) | `ingestEmail`(§5)、`INGEST_SOURCES`・`INGEST_PARSERS`、`Ingest_Log`、HTML 前処理、レート制限、`setupIngestSheet`、`doPost` の分岐。`test/gas-ingest-email.test.mjs`。SPECIFICATION(API 契約・§5 取込・Script Properties。§5 の転送の注意書きとフェーズ2の記述の一般化は Q9 の決定しだい)・CODEMAP 更新 | M |
| R-1(中継スクリプト + 手順書コミット) | `relay/card-notice-relay.gs`・`relay/settings.html`・`relay/appsscript.json`・`test/relay-card-notice.test.mjs`・`docs/guides/card-import-setup.md`(コマンド一覧を含む)。`eslint.config.mjs` の `globalIgnores` に `relay/**`、`.vercelignore` に `/relay`。SPECIFICATION に中継スクリプトの節。レビュー後にタグ(例 `relay-v1`)を付け、(b) の場合は管理者が共有フォルダに置く | M〜L |

- G-I1 は旧 UI と互換なので R-1 と同じ push でよい(GAS は別コミット)。
- 前設計書 §9.2・§9.3・§10.2 D13 を本書で置き換えた旨を、G-I1 で前設計書 §9 冒頭に 1 行追記する。

---

## 12. 不採用案(要点)

| 案 | 不採用の理由 |
| --- | --- |
| NAS ワーカーが元のメールボックスを IMAP で読む(旧版) | 携帯会社の IMAP 認証情報は取得のたびに作り直され、利用者の端末のメールが止まるおそれがあった。認証情報はメールボックス全体の読み書きに効き、管理者の NAS に常駐するため、管理者と AI がコードや設定を変えれば読めた。設定ページ・sudo によるコード配置・ハッシュ照合など運用が重い。`ingestEmail` の契約、送り先 URL の形式限定、お試しモード、成功応答のときだけ処理済みにする考え方は新方式に引き継いだ |
| 利用者が PC の script.google.com でコードを貼る(本書の前の版) | 利用者は PC を持たない。iPhone の Safari でのエディタ操作(2 ファイルの貼り付け、マニフェスト表示の切替、スクリプト プロパティ、実行ログ)は難しい |
| 利用者の Gmail をアプリパスワードで NAS が読む(前設計書 D13) | 通知が Gmail に届いていなかった。アプリパスワードは Gmail 全体の読み書き・送信に効く |
| 管理者の Gmail へ転送し、家計簿 GAS の GmailApp で読む | 利用者のメールが管理者の受信箱に入る。現行の取込が yahoo に入れてしまう(SPECIFICATION §5 の注意書き) |
| 中継スクリプトで `GmailApp` を使う | `https://mail.google.com/`(削除・送信を含む全権限)を要求する |
| 設定値を Claude 経由で clasp の `run` 等から入れる | `INGEST_SECRET` 等が会話と NAS に残る。設定フォームで利用者が直接入れる |
| 管理者が作ったテンプレートを利用者が「コピーを作成」 | コードの正本が 2 か所になる。コピー後の設定にエディタが要る |
