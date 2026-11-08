# 設計書: Yuki 用家計簿の追加とパスキー認証への移行

- 作成日: 2026-11-08
- 状態: **ドラフト(計画段階・未実装)**。ユーザー回答(2026-11-08)を反映済み。残る確認事項は §10.3
- 関連: [AGENTS.md](../../AGENTS.md) / [SPECIFICATION.md](../SPECIFICATION.md) / [CODEMAP.md](../CODEMAP.md) /
  [IMPROVEMENTS.md](../IMPROVEMENTS.md) / [kakeibo-gas SKILL](../../.agents/skills/kakeibo-gas/SKILL.md)

表記: 既存コードの事実は `ファイル:行` で根拠を示す(2026-11-08 時点の `main` = `eb19be0`)。
推測・未確認の事項は **要確認** と明記する。秘密値・実在の ID・実ドメインは記載せず `<本番ドメイン>` 等のプレースホルダで書く。

---

## 1. 目的・スコープ

### 1.1 目的

1. 新しい利用者「Yuki」が、自分の iPhone で自分専用の家計簿(source `yuki`)と、管理者と共有する家庭用(source `main`)を使えるようにする。
   Yuki は現在も共有パスワードで家庭用を使っている(移行前は管理者と同じ全権限)。
2. ログインを共有パスワード(`APP_PASSWORD`)から、利用者ごとのパスキー(WebAuthn / Face ID)へ移行する。
3. 「ユーザー × 閲覧可能 source」の汎用モデルを導入し、将来の利用者追加をコード変更最小で行えるようにする。

### 1.2 フェーズ1(本書で詳細設計)

- 利用者・権限モデル(ユーザー表、セッションへの埋め込み、middleware / プロキシ / GAS の三段強制)
- パスキー登録(招待リンク)・ログイン・セッション・失効・復旧・管理者ブートストラップ
- source `yuki` の追加(`Yuki_Data` / `Yuki_Config` / `Yuki_Fixed`)。機能は個人用(yahoo)と同等:
  ダッシュボード / カレンダー / 統計 / 管理(手入力・固定費)、固定費の自動登録、LINE 月次レポート(Yuki 本人の LINE 宛)
- `/yuki` 配下の画面(淡いピンクのテーマ)、Yuki・管理者の source 切替(Yuki は Yuki / 家庭用)、BottomNav・PWA manifest の source 対応、権限外 URL の挙動
- アカウント管理(招待発行・パスキー失効・全端末ログアウト)は **GAS エディタから実行する関数**で行う
  (専用の管理画面は作らない。利用者が2人の間は過剰なため。§5.6)
- **既存 GAS(`gas/コード.js`)を作り直さず拡張する**

### 1.3 フェーズ2(概要のみ、§9)

NAS 上のワーカーが IMAP でメールを読み、GAS の新アクション `ingestEmail` に本文を渡して既存パーサ・重複除外・RowId 採番・ロックで取り込む。
対象は **Yuki のカード通知のみ**(Yuki 本人の Gmail を IMAP で読む方式、§9)。個人用(yahoo)は現行の GmailApp 取込のまま。

### 1.4 非スコープ

- データストアの移行(Sheets → DB)、ホスティングの移行(Vercel → NAS)。ただし RP ID がドメインに縛られる点は §3.5 / §10 で扱う
- Yuki のメール自動取込(フェーズ2)。フェーズ1の Yuki は手入力と固定費のみ
- 管理者が Yuki のデータを**技術的に**見られなくすること(シート所有者は管理者。§2.4)
- 複数人での1つの source の共同編集時の競合 UI(既存の write-queue / Script Lock の範囲で扱う)
- E2E(Playwright)の実行。この作業環境では不可(§8)。ユーザー環境での実施手順のみ示す
- カテゴリ体系の source 別化(Yuki 専用カテゴリ)。Yuki も共通カテゴリ(`lib/categories.ts`)を使う(決定事項)

---

## 2. 利用者と権限モデル

### 2.1 現状

- 認証は「パスワードを知っているか」だけで、利用者の区別がない。セッションは `v1.<issued>.<expires>.<nonce>.<sig>`
  (`lib/session.ts:26`)で、ユーザー情報を持たない。
- 認証済みなら全 source を読み書きできる(`middleware.ts:8` の保護パス、`app/api/expenses/route.ts:55-57` の `isAuthenticated`)。
- source の許可は `main` / `yahoo` の固定列挙(`lib/expenses-proxy.ts:8`、`gas/コード.js:79-83`)。

### 2.2 データ構造(新規)

**ユーザー表 `Auth_Users`**(保存先は §3.7 で比較。推奨は GAS 管理の専用シート)

| 列 | 内容 |
| --- | --- |
| userId | 不透明なランダム ID(例 `u_` + 16 バイト乱数の base64url)。名前やメールを含めない。WebAuthn の `user.id`(userHandle)にも使う |
| displayName | 画面表示・パスキー名用(例「管理者」「Yuki」) |
| role | `admin` / `member`。当面は GAS 側の判定(パスワードログインでの管理者行の特定、§3.10)にのみ使う。Next.js に管理画面は無く、アカウント管理は GAS エディタ関数で行う |
| sources | 閲覧・編集可能な source の集合(管理者 `main,yahoo` / Yuki `yuki,main`) |
| homeSource | ログイン後の既定 source |
| epoch | 権限版数(整数)。権限変更・全端末ログアウト・端末失効時に +1。セッションに埋め込み、GAS で照合 |
| status | `active` / `disabled` |
| createdAt / updatedAt | 日時 |

初期データ(値はイメージ):

| displayName | role | sources | homeSource |
| --- | --- | --- | --- |
| 管理者 | admin | main, yahoo | main |
| Yuki | member | yuki, main | yuki |

- `main`(家庭用)は2人で共有、`yahoo`(個人用)は管理者のみ、`yuki` は Yuki のみ(決定事項)。

「管理者は Yuki のデータを見られない」「Yuki は管理者の個人用を見られない」は **role ではなく sources で決まる**(admin も `yuki` を持たず、Yuki は `yahoo` を持たない)。
role=admin はデータ閲覧権限とは独立で、当面は GAS 側でパスワードログイン時の管理者行の特定にのみ使う。

**source レジストリ**(コードに持つ。データではない)

| source | 画面ルート | シート | LINE 宛先 Property | テーマ |
| --- | --- | --- | --- | --- |
| `main` | `/`, `/statistics`, `/calendar`, `/manage` | `Data` / `Config` / `Fixed` | `LINE_DESTINATION_MAIN` | ライト |
| `yahoo` | `/yahoo/...` | `Yahoo_*` | `LINE_DESTINATION_YAHOO` | ダーク |
| `yuki` | `/yuki/...` | `Yuki_*` | `LINE_DESTINATION_YUKI` | 淡いピンク(ライト系、§4.5) |

Next.js 側は新規 `lib/sources.ts`、GAS 側は `SOURCES` 定数に同内容を持ち、両者の一致をテストで検査する
(既存の `test/edit-actions-consistency.test.mjs` と同じ発想)。

### 2.3 どこで強制するか(三段)

| 層 | 何を見るか | 目的 | 失敗時 |
| --- | --- | --- | --- |
| middleware(`middleware.ts`) | セッション Cookie(署名・期限・`sources`) とパス→source の対応 | 画面遷移の振り分け(UX)と早期拒否 | 画面: 自分のホームへリダイレクト / API: 403 |
| プロキシ(`app/api/expenses/route.ts`) | 同じ Cookie を独立に再検証し、要求 source ∈ `sources` を確認。GAS へ `actor`(userId, epoch)を付与 | middleware の matcher 漏れ等への多層防御。**データへの唯一の入口** | 403 `{ error: 'Forbidden' }`。GAS を呼ばない |
| GAS(`gas/コード.js` doGet/doPost) | `PROXY_SECRET` 照合 → `actor.userId` のユーザー行(status / epoch / sources)と要求 source | 失効(epoch)の即時反映と、ユーザー表を正本とした最終判定 | `{ error: 'Forbidden' }` / `{ error: 'SessionRevoked' }` |

- middleware とプロキシはステートレス(Cookie だけで判定、追加の通信なし)。
- GAS は既に全データ要求の終点なので、ユーザー表の照合を追加しても**往復は増えない**(Script Cache から読む。§5.7)。
- 既存の `isAuthenticated` 二重チェック(`app/api/expenses/route.ts:60,80`)の方針を踏襲する。

### 2.4 「GAS は共有シークレットでプロキシを信頼する」前提の妥当性

- GAS Web App は `ANYONE_ANONYMOUS` で公開され(`gas/appsscript.json` の `webapp.access`)、HTTP ヘッダを読めない。
  したがって GAS が呼び出し元を識別できる手段は本文/クエリの共有シークレットのみ(`gas/コード.js:52-60`)。
- この設計では **プロキシ(Vercel のサーバー)を信頼の主体**とし、`actor` はプロキシがセッション検証後に付与する。
  クライアントが送った `actor` は `key` と同様に必ず除去・上書きする(`lib/expenses-proxy.ts` の `toGasBody` と同じ扱い)。
- 妥当とする理由: (1) シークレットを持つのはプロキシだけで、ブラウザには渡らない、(2) GAS 側の照合は
  「プロキシが乗っ取られた場合」ではなく「古い/失効したセッション」と「プロキシのバグ」に対する防御として位置付ける、
  (3) GAS で WebAuthn 署名や HMAC セッションを再検証する案は、GAS に ECDSA 検証 API が無く(要確認: Apps Script の
  `Utilities` は HMAC/ダイジェスト/RSA 署名生成はあるが ECDSA 検証は無い)、セッション鍵を GAS にも配る必要が生じ利点が小さい。
- 前提条件: **`PROXY_SECRET` の「未設定なら素通し」(`gas/コード.js:54-57`、IMPROVEMENTS 4-1 の残課題)を
  Yuki 公開前に解消する**。少なくとも `yuki` source と認証系アクションは、`PROXY_SECRET` 未設定時は常に拒否する。
- 残る限界(仕様として明記する):
  - シート所有者(管理者)は Google スプレッドシート上で `Yuki_*` を直接閲覧できる。アプリ上・サーバー側で
    閲覧できないことは保証するが、所有者による閲覧は技術的に防げない。
  - 管理者は Vercel / GAS / GitHub の管理権限を持つため、コード変更や招待発行で Yuki になりすますことも技術的には可能。
    緩和として、Yuki のアカウントにパスキーが追加されたとき Yuki の LINE に通知する(§3.9)。
  - 上記2点は Yuki に説明して了承を得る(ユーザー側タスク、§10.3)。
  - 移行期間(パスワード廃止まで)は、共有パスワードでログインすると誰でも管理者のセッション(yahoo を含む)になる。
    これは現状と同じ権限だが、期間を最小にする(§3.10、§7.2)。

---

## 3. パスキー認証の設計

### 3.1 ライブラリ

`npm view` で確認(2026-11-08):

| パッケージ | 最新 | 最終リリース | 備考 |
| --- | --- | --- | --- |
| `@simplewebauthn/server` | 14.1.0 | 2026-11-06 | `engines.node >= 22`。14.0.3 は 2026-09-25 |
| `@simplewebauthn/browser` | 14.0.0 | 2026-09-02 | 依存なし |

- 採用: **`@simplewebauthn/server` 14.0.3 と `@simplewebauthn/browser` 14.0.0 を完全固定**(メジャーを揃える)。
  14.1.0 はリリース後2日のため、2週間以上経過し変更内容を確認してから上げる。
- サーバー側は Node.js ランタイムの Route Handler でのみ使う(middleware = Edge では使わない)。
  Vercel / CI は Node 24 で `engines` を満たす(`.github/workflows/deploy.yml` の `node-version: 24`)。
- 自前実装(CBOR/COSE 解析・署名検証)は行わない。

### 3.2 方針

- 認証方式: パスキーのみ(ユーザー名入力なし)。**discoverable credential**(`residentKey: 'required'`)で、
  ログイン時は `allowCredentials` を空にし、端末が提示したパスキーの `userHandle` / credentialId から利用者を特定する。
- `userVerification: 'required'`(Face ID / パスコード必須)、`attestation: 'none'`、
  アルゴリズムは ES256(-7)と RS256(-257)。
- iPhone の iCloud キーチェーン同期パスキーを主対象とする。カウンタは常に 0 になり得る(§3.7)。

### 3.3 登録(招待リンク)

1. 管理者が GAS エディタで `createInvite(<ユーザーの displayName または userId>, 'register' | 'recovery')` を実行する
   (ユーザー行が無ければ `setupAuthSheets` / `addUser` で先に作る)。
   - GAS が招待トークン(`Utilities.getUuid()` を2つ連結した約 244 ビットの乱数。要確認: `getUuid` が暗号学的乱数であること。
     不十分なら `Utilities.computeDigest` で乱数源を混ぜる)を生成し、`Auth_Invites` には **SHA-256 ハッシュのみ**と
     userId・目的・有効期限・発行日時を保存する。生トークンは保存しない。
   - 有効期限: **24 時間**(決定事項)。1回限り。同一ユーザーの未使用招待は新規発行時に無効化。
   - リンク `https://<本番ドメイン>/invite#<token>` は **GAS の実行ログにのみ**出力する(シート・応答・通知には出さない)。
     管理者がそれを LINE 等で Yuki に渡す。トークンは URL フラグメントに置き、Vercel のログ・Referer に残さない。
2. Yuki が iPhone の Safari でリンクを開く。`/invite` ページがフラグメントを読み、
   `POST /api/auth/register/options { token }` を送る。
3. サーバーが GAS `authPeekInvite` で有効性を確認(未使用・期限内)し、`generateRegistrationOptions` を返す。
   `excludeCredentials` に既存パスキーを入れ、同じ端末の二重登録を防ぐ。チャレンジは §3.4 の短命 Cookie に保持。
4. ブラウザが `startRegistration` → Face ID。
5. `POST /api/auth/register/verify` で `verifyRegistrationResponse`(expectedChallenge / expectedOrigin / expectedRPID /
   requireUserVerification)を検証後、GAS `authConsumeInviteAndAddCredential` を呼ぶ。
   GAS は **Script Lock 内で**招待の未使用・期限を再確認し、招待を使用済みにして資格情報を追加する(原子的に1回限り)。
6. 成功したらセッション Cookie を発行し、ホーム(`/yuki`)へ遷移。「ホーム画面に追加」の案内を表示する。

**パスキーの追加(ログイン中の本人が2台目の端末等を登録)** は、セッションだけでは許可せず、**追加のたびに既存パスキーでの再認証**を必須にする
(盗まれたセッション Cookie だけで攻撃者のパスキーを追加されることを防ぐ)。

1. `POST /api/auth/passkeys/add/options`: サーバーが**新しいチャレンジ**で認証オプション(`allowCredentials` = 本人の有効なパスキー)を返す。
2. 本人が既存パスキーで `startAuthentication`(Face ID)。`POST .../add/reauth` で `verifyAuthenticationResponse` を検証し、
   assertion の userHandle がセッションの userId と一致することを確認。成功したら、登録用の**別の新チャレンジ**を
   「再認証済み・userId 固定・有効 5 分」の短命 Cookie(§3.4、purpose=`add`)で返す。
3. `startRegistration` → `POST .../add/verify` で検証し、GAS `authAddCredential` で追加。GAS も epoch 一致を確認する。

例外(ブートストラップのみ): パスキーを1つも持たない管理者が最初のパスキーを登録するときは、既存パスキーの代わりに
**`APP_PASSWORD` の再入力**を再認証とする(§3.10)。パスキーを1つ以上持つ利用者にはこの代替を使わせない(GAS で件数を確認)。

### 3.4 チャレンジの保持(ステートレス)

- 推奨: **署名付き短命 Cookie** `kakeibo_webauthn`(HttpOnly / Secure / SameSite=Strict / Path=`/api/auth` / 有効 5 分)。
  内容: `wa1.<purpose>.<issued>.<expires>.<challenge>.<inviteHash or userId>.<sig>`。
  - 署名鍵は `SESSION_SECRET` から用途別に導出する(HKDF または `HMAC(SESSION_SECRET, "webauthn-challenge")`)。
    セッショントークンと書式・鍵を分け、相互に流用できないようにする。
  - verify 成功・失敗いずれでも Cookie を削除する。
- 再利用防止: Cookie 自体はステートレスだが、検証に成功したチャレンジの SHA-256 を GAS の Script Cache に 5 分間記録し、
  同じチャレンジの2回目を拒否する。記録は既存の往復に相乗りする(ログインは `authRecordCredentialUse`、登録は
  `authConsumeInviteAndAddCredential` / `authAddCredential` の中で「未記録なら記録して続行、記録済みなら `ChallengeReused`」を
  Script Lock 内で行う)。往復は増えない。Script Cache の消失時は 5 分の有効期限と署名が残りの防御になる。
- 代替案(不採用): チャレンジ自体を GAS に保存 → options の段階でも GAS 往復が1つ増える(コールド 1〜3 秒)。

### 3.5 RP ID / origin

- `rpID` と `expectedOrigin` は環境変数 `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` で明示し、**`Host` ヘッダから導出しない**。
  値は本番の `<本番ドメイン>`(**現状の Vercel ドメインのまま。決定事項**。例: `<project>.vercel.app` 形式)。
  - `vercel.app` は Public Suffix List に載っているため、RP ID は `vercel.app` にできず、完全なホスト名にする必要がある。
- **パスキーは RP ID に縛られる**。将来ドメインを変える(独自ドメイン取得、IMPROVEMENTS「ホスティング比較」C/D の NAS 移行)と
  全員のパスキーが使えなくなる。緩和策: 新ドメインで再登録(招待)するか、WebAuthn Related Origin Requests
  (`/.well-known/webauthn`)を使う(要確認: iOS Safari の対応状況)。現時点でドメイン変更の予定はない(決定事項)。
- プレビュー環境: 現行運用は Vercel Git 連携が無効で、本番のみデプロイ(SPECIFICATION §8)。プレビューを作る場合は
  ホストが異なりパスキーが使えないため、プレビューでは認証を「無効(全拒否)」とし、検証はローカルで行う。
- ローカル開発: `WEBAUTHN_RP_ID=localhost`、`WEBAUTHN_ORIGIN=http://localhost:3000`(WebAuthn は localhost を安全なコンテキストとして扱う)。
  ローカル用ユーザー表は架空データ(GAS のテスト用デプロイ、または開発時のみ有効なメモリ実装)。

### 3.6 ログイン

1. `/login` の「パスキーでログイン」ボタン → `POST /api/auth/login/options`(GAS 往復なし、チャレンジ Cookie を発行)。
2. `startAuthentication`(`allowCredentials` なし)→ Face ID。iOS の Conditional UI(`useBrowserAutofill`)は任意。
3. `POST /api/auth/login/verify`: GAS `authGetCredential { credentialId }` で公開鍵・カウンタ・userId・ユーザー行を取得
   (失効済み・`disabled` は拒否)→ `verifyAuthenticationResponse` → 成功なら GAS `authRecordCredentialUse`
   (lastUsedAt、カウンタが増加した場合のみ更新、チャレンジの再利用確認 §3.4)→ セッション Cookie 発行。
   - `authRecordCredentialUse` が `ChallengeReused` ならログイン失敗。それ以外の失敗(Busy 等)はログインを失敗させない(ログのみ)。
4. 応答で `homePath` を返し、`returnTo` があれば §4.2 の検証を通ったものだけ採用する。
5. GAS は2往復(取得+記録)。ログインは 30 日に1回程度なので許容する。

### 3.7 公開鍵・カウンタ・ユーザー・権限の保存先

| 案 | 長所 | 短所 |
| --- | --- | --- |
| **A. GAS 管理の専用シート(推奨)** `Auth_Users` / `Auth_Credentials` / `Auth_Invites` / `Auth_LineLinks` | 新規インフラ・新規契約なし。既存の Script Lock・共有シークレット・デプロイ経路・GAS VM テストをそのまま使える。GAS が epoch を照合でき、失効が往復追加なしで効く | ログイン時に GAS 往復(1〜3 秒)。シート所有者が表を見られる(公開鍵は秘密ではない。招待トークンはハッシュのみ保存) |
| B. Vercel 連携の KV(Upstash Redis 等) | 低レイテンシ | 新サービス・新しい秘密情報・運用対象が増える。GAS の epoch 照合のために結局 GAS へ同期が必要 |
| C. Vercel Edge Config / 環境変数に JSON | 読み取り最速 | 書き込み(招待消費・カウンタ)が API 経由または再デプロイになり、招待の1回限りを原子的に実装できない |
| D. Sheets を Next.js から直接(サービスアカウント) | GAS を経由しない | 新たな Google 認証情報が必要。既存の「データ層は GAS 経由」の構成を崩す |

推奨は A。スプレッドシートは他者と共有していない(決定事項)ため、`Auth_*` も `Yuki_*` も既存スプレッドシート内に置く(`SHEET_ID` を共用)。
将来共有する場合は、別スプレッドシート(Script Property `AUTH_SHEET_ID`)に分ける。

`Auth_Credentials` 列: credentialId(base64url)、userId、publicKey(base64url COSE)、counter、transports、
deviceType、backedUp、label(例「iPhone」)、createdAt、lastUsedAt、revokedAt。
`Auth_Invites` 列: inviteId、tokenHash、userId、purpose、expiresAt、createdBy、usedAt。
全シートで数式インジェクション対策として値の先頭 `= + - @` を拒否する(IMPROVEMENTS 7-2 と同じ方針)。

### 3.8 セッション

- 既存の HMAC 方式(`lib/session.ts`)を拡張し、**v2 トークン**を導入する:
  `v2.<issued>.<expires>.<nonce>.<userId>.<epoch>.<sources>.<amr>.<sig>`(sources は `main+yahoo` のように連結。role は Next.js で使わないため含めない)。
  - `amr`(認証方式)は `pwd`(共有パスワード)または `pk`(パスキー)。パスキーでの登録・ログイン・再認証後は `pk`、パスワードログインは `pwd`。
  - 有効期間は現行と同じ 30 日(`lib/session.ts:3`)。長さ上限 256(`lib/session.ts:32`)は 512 に拡張。
  - `verifySession` は真偽値ではなく `{ userId, epoch, sources, amr } | null` を返す `readSession` に置き換える。
  - **`APP_PASSWORD` 未設定(=パスワード廃止後)のとき、`readSession` は `amr=pwd` のセッションを無効として扱う**。
    middleware(画面・API)とプロキシ(`/api/expenses`)はどちらも `readSession` を使うため、廃止後は移行期間のパスワードセッションで
    画面も API も通らない(Next.js の一覧キャッシュ経路も含む)。これが主たる防御で、GAS の epoch 照合(下記)は補助防御として残す。
    middleware と GAS の epoch 照合だけに頼ると、middleware とプロキシは epoch を見ないため、失効後も画面の表示(localStorage の
    キャッシュ先出し)や Next.js キャッシュ経由の一覧(最大5分)が通ってしまう。
  - Cookie 属性は現行どおり HttpOnly / SameSite=Strict / Path=/ / 本番 Secure(`app/api/auth/verify/route.ts:23-29`)。
- 失効方法:
  | 対象 | 方法 | 反映 |
  | --- | --- | --- |
  | 1 利用者の全端末 | `epoch` を +1(本人の「全端末からログアウト」、GAS エディタ関数 `bumpEpoch`、権限変更、パスキー失効時に自動) | 書き込みは即時。一覧読み取りは Next.js キャッシュ(最大5分、`app/api/expenses/route.ts:45`)の間は旧 Cookie でも返り得る(§5.7) |
  | 1 パスキー | `revokedAt` を設定(以後そのパスキーでログイン不可)+ epoch +1 | 同上 |
  | 全員 | `SESSION_SECRET` のローテーション(現行どおり) | 即時 |
  | ログアウト(自分) | `POST /api/auth/logout` で Cookie 削除 + localStorage の `kakeibo_expenses_cache*` を消去 | 即時(端末内) |
- ログアウトは現状存在しない(`grep logout` で該当なし)。共用端末で他人の明細キャッシュ
  (`hooks/useExpenses.ts:8,25` の localStorage)が残るため、次のときに `kakeibo_` で始まる localStorage をすべて消去する。
  - ログアウト時。
  - **ログイン成功時に利用者が変わったとき**。ログイン成功時に userId を localStorage(`kakeibo_user`)に記録し、
    記録が無い場合(v1 時代・移行期間の端末を含む)も「利用者が変わった」とみなして消去してから記録する。
  - **401 を受けたとき**(プロキシの `Unauthorized`、`SessionRevoked` 由来の 401、`amr=pwd` 拒否を含む)。`lib/api.ts` の取得と
    `lib/write-queue.ts` の書き込みで 401 を検知したら消去して `/login` へ遷移する。
  - middleware が未ログイン・無効セッションで画面を `/login` にリダイレクトするときは `reason=session` を付け、
    `/login` はこれを見て消去する(画面がキャッシュを先に描画する前に消す)。
- v1 Cookie の扱い: v2 導入時点で無効とし、パスワードで再ログイン(移行期間のみ。管理者・Yuki とも admin の v2 セッションになる)。
- 移行期間に Yuki の端末で admin セッションが使われると、yahoo の明細が localStorage(`hooks/useExpenses.ts:25`)に残り得る。
  Yuki がパスキーで登録・ログインした時点で `kakeibo_` で始まる localStorage を消去する(上記の仕組み。移行期間の端末は
  `kakeibo_user` の記録が admin、または記録が無いので、必ず消去される)。

### 3.9 複数端末・機種変更・紛失時の復旧

- 各利用者は**パスキーを2つ以上**持つことを推奨(iPhone の iCloud キーチェーン同期 + もう1台の Apple 端末、
  またはハードウェアキー)。本人のパスキー画面に「パスキーが1つだけです」の注意を表示する。
- 機種変更: iCloud キーチェーン同期パスキーは同じ Apple ID の新しい iPhone に自動で移るため、操作不要。
  Yuki の iPhone は iCloud キーチェーン有効の見込み(前提。初回登録時にパスキーが「iCloud キーチェーン」に保存されたことを確認する)。
  同期されない場合は復旧招待で再登録。
- 紛失・盗難: 本人(別端末でログインできれば)または管理者が GAS エディタ関数 `revokeCredential` で該当パスキーを失効
  (epoch +1 で全セッション失効)→ 管理者が `createInvite(..., 'recovery')` → 新端末で登録。
  - 紛失端末は Face ID / パスコードが無いとパスキーを使えないが、ログイン済みセッション Cookie は epoch 失効まで有効なので即失効させる。
- **Yuki のアカウントにパスキーが追加された時**、Yuki の LINE(連携済みなら)へ「新しい端末が登録されました」を送る
  (管理者による招待悪用の可視化)。
- 管理者自身が全パスキーを失った場合の非常口: 通常の招待と同じ GAS エディタ関数 `createInvite(<管理者>, 'recovery')`
  (有効期限は 10 分に短縮)。URL は実行ログにのみ出る(Google アカウント=シート所有者でしか実行できない)。
  `APP_PASSWORD` の再設定は非常口にしない(パスワードログインのコードは最終的に削除するため)。

### 3.10 管理者の初回ブートストラップとパスワード廃止

廃止の順序(決定事項): **管理者のパスキー登録 → Yuki の招待・登録確認 → パスワード廃止**。
Yuki も現在の共有パスワードを使っているため、Yuki がパスキーで入れるようになるまでパスワードを残す。

1. GAS で `setupAuthSheets()`(エディタ実行、冪等)が `Auth_*` シートを作成し、管理者ユーザー行(role=admin、sources=main,yahoo)を作る。
2. UI リリース後、パスワードログインは**管理者ユーザーの v2 セッションのみ**を発行する(パスワードは共有のため、入力者を区別できない)。
   - パスワード照合(定数時間に変更。現状 `===`、`app/api/auth/verify/route.ts:19`、IMPROVEMENTS 7-1)の成功後、
     GAS の新アクション **`authGetAdminUser`**(`PROXY_SECRET` 必須、未設定なら `Unauthorized`。入力なし)で
     role=admin かつ `active` のユーザー行(userId・epoch・sources)を1件取得し、その値で v2 セッションを発行する。
     管理者行が無い・複数ある・GAS が失敗した場合はログイン失敗(500 / 503)とし、**ユーザー情報なしのセッションは発行しない**。
   - このため `setupAuthSheets()` の実行(管理者行の作成)は UI リリースより前に必須(§7.2)。
   - **移行期間のリスク**: パスワード廃止まで、Yuki がパスワードでログインすると管理者権限のセッション(yahoo も見える)になる。
     これは現状と同じ権限で悪化ではないが、新しい権限モデルの効果はパスワード廃止まで得られない。
3. 管理者が「パスキーを追加」で最初のパスキーを登録する。このときだけ再認証は **`APP_PASSWORD` の再入力**で代替する(§3.3)。
   2台目以降は1台目のパスキーで再認証して追加する。
4. 続けて Yuki を招待し、Yuki が自分の iPhone でパスキー登録・ログインできること(ホーム画面アプリを含む)を確認する。
5. 確認できたら直ちにパスワードを廃止する。Vercel の環境変数は**再デプロイするまで反映されない**ため、次の順で行う。
   1. Vercel(Production)から `APP_PASSWORD` を削除する。
   2. 再デプロイする(GitHub Actions の `deploy.yml` を `workflow_dispatch` で実行。GAS は差分なしでスキップされ Vercel だけが出る。
      本番デプロイなのでユーザーの承認後に実行)。
   3. `/login` にパスワード欄が無いこと、パスワードログイン API(`POST /api/auth/verify`)が 404 を返すこと、
      移行期間のパスワードセッションのまま画面・`/api/expenses` にアクセスすると `/login` / 401 になること(`amr=pwd` 拒否、§3.8)を確認する。
   4. GAS エディタ関数 `bumpEpoch(<管理者>)` で**管理者の epoch を上げる**(補助防御。`amr=pwd` 拒否が効かない経路が残っていても GAS で止める)。
      管理者はパスキーで入り直す。
6. 安定後(目安 2 週間)、パスワードログインのコードと v1 互換を削除するコミットを出す。
   - **実施(2026-11、U6)**: ユーザー決定により Vercel の `APP_PASSWORD` は削除しない前提で、コードで無効化した。
     `/api/auth/verify` は公開のまま常に 404(古い画面向け)、`readSession` は `amr=pwd` を常に無効、`/login` のパスワード欄・
     パスキー追加の bootstrap(ルート・チャレンジ purpose・画面)を削除、`APP_PASSWORD` を参照するコードなし。
     復旧手段は GAS エディタの `createAdminRecoveryInvite()` / `createYukiRecoveryInvite()` だけ。

移行期間を短くするための運用:
- 手順 3〜5 を UI リリース当日に、Yuki が手元にいる時間帯に続けて行う(目標: UI リリースからパスワード廃止まで1日以内)。
- 招待リンクは手順 3 の直後に発行する(有効期限 24 時間なので、Yuki の都合のよい時間を先に決めておく)。
- Yuki には移行期間中、パスワードログインでは家庭用だけを使い、個人用(yahoo)の画面を開かないよう依頼する(運用上のお願い。技術的強制ではない)。

### 3.11 PWA(ホーム画面アプリ)での動作

- iOS 16 以降、ホーム画面に追加した Web アプリ(standalone)でも WebAuthn / パスキーが使える。Yuki の iPhone は iOS 16 以上の見込み(前提)。
  初回登録時に iOS バージョンとホーム画面アプリでのログインを確認する。
- iOS のホーム画面アプリは Safari と Cookie / localStorage が分離される(要確認: iOS 17 以降の挙動)。
  パスキー自体は iCloud キーチェーンにあるため、Safari で登録 → ホーム画面アプリで再度「パスキーでログイン」すればよい。
  登録完了画面にこの案内を出す。
- 招待リンクは Safari で開く前提(LINE 内ブラウザ等ではパスキー登録が失敗し得る)。`/invite` で
  アプリ内ブラウザを検知したら「Safari で開いてください」と表示する(要確認: 判定方法)。
  - 修正(2026-11): アプリ内ブラウザでは URL フラグメントのトークンを消さない(「Safari で開く」が今の URL を渡すため、消すと
    Safari 側で「招待リンクが正しくありません」になっていた)。登録完了で消す。案内とエラー文に「リンクを長押しでコピーして
    Safari のアドレス欄に貼り付け/iMessage で送ると確実」を追加。履歴にトークンが残るのは、1回限り・24時間・使用で消費のため許容。
- manifest の `scope` は `/` にする。`/yuki` に限定すると `/login` 等が scope 外になり iOS がブラウザ UI を出すため。

### 3.12 アプリロック(アイドル 30 分で顔認証を再要求)

ユーザー要望(2026-11): ほぼ毎回 Face ID を求めたい。セッション(30日)は残し、最後の利用から **30 分**を超えたら顔認証を求める。
正本の仕様は SPECIFICATION §2「アプリロック」。定数は `lib/app-lock.ts` の `APP_LOCK_IDLE_MS` だけ。

- サーバー: 署名付きのスライド Cookie `kakeibo_active`(セッションの userId・epoch に紐づけ、`SESSION_SECRET` から用途別に導出した鍵)。
  ログイン・招待登録で発行し、middleware がロックを通過した保護パスの要求ごとに更新する。無い/期限切れなら画面は
  `/login?reason=locked`(自動で顔認証)、API は 401 `Locked`。セッションも localStorage も消さない(同じ利用者の再取得を避ける)。
  公開パスと `/api/auth/logout` は対象外、`/settings/*` は対象。`/login` を開くと削除する。
- クライアント: iOS の PWA はメモリから復帰しても要求を出さないため、`visibilitychange`(と bfcache 復帰・最初のタップ・30秒ごとの確認)で
  最後の操作(localStorage)から30分を超えていればロック画面へ移る。
- PM 案(可視化時に `location.reload()` して middleware に判定させる)からの変更点と理由:
  - クライアントが自分でロック画面へ移る。操作時刻はクライアントにしか分からず、reload だとサーバーの最終要求からの時間で判定することになり、
    要求を伴わない閲覧(スクロール等)が「利用」に数えられないため。代わりに操作時に1分ごとに ping してサーバーの窓を追従させる。
  - サーバーの窓は 30分+ping 間隔(1分)= 31分。クライアントが「利用中」と判定している間は必ずサーバーも有効なので、
    書き込みキュー未完了のまま 401 `Locked` で書き込みを失うことがない。クライアントはキューが空になってからロック画面へ移る。
  - ロック判定後の最初のタップは捕捉段階で止める(ロック直前の画面で編集が始まらないように)。

---

## 4. 画面とルーティング

### 4.1 ルート

| パス | 対象 | 実装 |
| --- | --- | --- |
| `/yuki`, `/yuki/statistics`, `/yuki/calendar`, `/yuki/manage` | source=yuki | `app/yahoo/*` と同形。既存コンポーネントに `source="yuki"` とテーマ(§4.5)を渡す(`app/yahoo/page.tsx:4` 等と同じ) |
| `app/yuki/layout.tsx` | Yuki 用メタデータ | `manifest: "/yuki-manifest.json"`、`appleWebApp.title`、アイコン、淡いピンクの背景色・`themeColor`(`app/yahoo/layout.tsx:4-11` と同じ構成) |
| `/api/auth/session` | ログイン中の本人 | `{ displayName, sources, homeSource }` を返す(秘密情報なし)。BottomNav の source 切替の表示に使う |
| `/invite` | 未ログイン可 | 招待トークンを読み登録 |
| `/settings/passkeys`(または各 manage 画面内) | ログイン中の本人 | 自分のパスキー一覧・追加(再認証付き)・全端末ログアウト・ログアウト、LINE 連携(yuki) |
| `/api/auth/register/*`, `/api/auth/login/*` | 未ログイン可 | §3 |
| `/api/auth/passkeys/*`, `/api/auth/logout`, `/api/auth/line-link` | ログイン中の本人 | §3.3 / §3.8 / §5.4 |

管理画面(`/admin/*`、`/api/admin/*`)は作らない。招待発行・パスキー失効・他人の全端末ログアウトは GAS エディタ関数で行う(§5.6)。
利用者が増えて GAS エディタ運用がつらくなったら、その時点で管理画面を別タスクとして検討する。

既存コンポーネントの source 依存箇所(`yuki` 対応で直すもの):

- `components/BottomNav.tsx:14` は `isYahoo` の二値判定。パスの先頭セグメントから source レジストリを引く形に変える
  (`?source=` クエリによる判定は廃止または検証付きに)。タブのリンク先は現在の source のルート配下にする。
- **source 切替**: 利用者の sources が2つ以上のとき、画面上部(各 View のヘッダー)に source 切替(セグメント)を表示する。
  Yuki は「Yuki / 家庭用」、管理者は「家庭用 / 個人用」。同じタブ(レポート・統計・カレンダー・管理)のまま
  対応するルートへ移動する(例: `/yuki/calendar` ⇄ `/calendar`)。sources は `/api/auth/session` から取得し、表示するだけで
  権限判定には使わない(判定は middleware・プロキシ・GAS)。
  - 汎用ルール(sources が2つ以上なら表示)のため、管理者にも「家庭用 / 個人用」の切替が出る。現状の行き来の方法
    (別のホーム画面アプリ)はそのまま使え、切替は追加の手段になるだけで既存の導線は変えない。
- `components/Dashboard.tsx:170` の見出し、`components/ManageView.tsx:36,113` の `isYahoo` による見出しを、レジストリの表示名に置換。
- テーマは source に従う(利用者ではなく、見ている家計簿で色が決まる)。Yuki が家庭用を開くと家庭用の配色になり、
  どちらの家計簿を見ているかが色で分かる。詳細は §4.5。

### 4.2 ログイン後の振り分け・`returnTo`

- ログイン成功時の遷移先: `returnTo` が「同一オリジンの相対パス(`/` 始まりで `//` ・`\` を含まない)かつ
  パスの source ∈ セッションの sources」なら採用、そうでなければ `homeSource` のホーム。
  現状の `router.push(returnTo || '/')`(`app/login/page.tsx:26`)は `//外部` を許す(IMPROVEMENTS 7-1)ので同時に直す。
- ログイン後の既定画面: 管理者は `/`(main)、**Yuki は `/yuki`**(`homeSource`)。
- Yuki は main を持つので `/` 等の家庭用画面にもアクセスできる(切替またはURL直接)。`/yahoo/*` は Yuki のホーム `/yuki` へリダイレクト。
- Yuki のホーム画面アプリは `start_url: /yuki` で起動する(§4.4)。

### 4.3 権限のない URL へのアクセス

| 状況 | 挙動 |
| --- | --- |
| 未ログインで保護パス | 現行どおり `/login?returnTo=...`(`middleware.ts:21-23`) |
| ログイン済みだが source 権限なし(画面) | 自分の `homeSource` のホームへ 307 リダイレクト。データ取得は発生しない |
| 同(API `/api/expenses`) | 403 `{ error: 'Forbidden' }`(GAS を呼ばない) |
| GAS が `SessionRevoked` | プロキシは 401 を返し Cookie を削除。クライアントは `kakeibo_` 始まりの localStorage を消去して `/login` へ |
| パスワード廃止後に `amr=pwd` のセッション | middleware: 画面は `/login?reason=session` へ(Cookie 削除)、API は 401。プロキシも独立に 401 |

- 「存在を隠す」ために 404 にする案もあるが、自分の家計簿へ戻す方が分かりやすいためリダイレクトを採用。
- middleware の保護対象(`middleware.ts:8`)は列挙ではなく「公開パス以外は全部保護」に変える
  (新しいルートの追加漏れを防ぐ)。公開: `/login`, `/invite`, `/api/auth/register/*`, `/api/auth/login/*`, `/api/line/webhook`, manifest・アイコン等の静的ファイル。
  なお現在の matcher(`middleware.ts:40`)の `login` 除外は `login` で始まる任意のパスに一致するため、`/login` 完全一致に直す。

### 4.4 Yuki 用 PWA manifest

- `public/yuki-manifest.json`(`public/yahoo-manifest.json` と同形): `name` / `short_name`、`start_url: "/yuki"`、
  `scope: "/"`(家庭用への切替も同じアプリ内で開くため)、`display: "standalone"`、`theme_color` / `background_color` は淡いピンク(§4.5)、
  アイコンは Yuki 用の画像(ピンク系。画像はユーザーが用意、用意できるまでは既存 `public/image.png` を流用)。
- 未ログインで `/yuki` を開くと `/login?returnTo=/yuki` → ログイン後 `/yuki` に戻る。
- manifest とアイコンは未ログインでも取得できる必要がある(現状 `/yahoo-manifest.json` は保護パスに一致しない。§4.3 の
  「公開パス以外は全部保護」に変える際、manifest・アイコンを公開リストに入れる)。

### 4.5 Yuki のテーマ(淡いピンク、ライト系)

決定事項: Yuki の画面は淡いピンクのライト系。

- 現状のテーマは `isDarkMode`(真偽値)だけで、各 View が `isDarkMode ? ダーク : ライト` を直書きしている
  (`Dashboard.tsx` 28 箇所、`CalendarView.tsx` 26 箇所、`ManageView.tsx` 30 箇所など)。アクセント色は indigo 固定。
- 方針: `isDarkMode` はそのまま残し(yahoo はダーク、main と yuki はライト)、**アクセント色だけを source ごとに切り替える**。
  - `lib/sources.ts` の各 source に `theme: { dark: boolean, accent: 'indigo' | 'pink', background: string }` を持たせる。
    main = ライト + indigo、yahoo = ダーク + indigo(現状維持)、yuki = ライト + pink。
  - 新規 `lib/theme.ts` に accent ごとの Tailwind クラス対応表(見出しのグラデーション、選択中タブ、ボタン、グラフの強調色など)を置き、
    各 View の indigo 直書きをこの表の参照に置き換える。Tailwind はクラス名を静的に検出するため、
    `bg-${accent}-500` のような動的生成はせず、完全なクラス名を表に書く。
  - 背景: 既存の `BodyBackgroundSetter`(`app/yahoo/layout.tsx` で使用)で `app/yuki/layout.tsx` の背景を淡いピンク
    (例: Tailwind `pink-50` 相当の `#fdf2f8`)にする。カードは白のまま、境界線を `pink-100` 相当にする。
  - `viewport.themeColor`(`app/yuki/layout.tsx`)と manifest の `theme_color` / `background_color` も同じ淡いピンクにする
    (iOS のステータスバーと起動画面の色が揃う)。`appleWebApp.statusBarStyle` は `default`(ライト系のため)。
  - main / yahoo の見た目は変えない(置き換え前後で同じクラスになることをレビューで確認)。
- 円グラフのカテゴリ色はテーマに関係なく共通(カテゴリの判別を優先)。

---

## 5. GAS の変更点

### 5.1 source レジストリ化と `yuki` 追加

- `SOURCES = { main: {data:'Data', config:'Config', fixed:'Fixed', label:'家庭用', lineKey:'LINE_DESTINATION_MAIN'},
  yahoo: {...'Yahoo_*', label:'個人用', lineKey:'LINE_DESTINATION_YAHOO'}, yuki: {...'Yuki_*', label:'Yuki', lineKey:'LINE_DESTINATION_YUKI'} }`
- `normalizeSource`(`gas/コード.js:79-83`): `yuki` を受理。
- `getTargetSheets`(`gas/コード.js:142-155`): 現状は `yahoo` 以外をすべて main のシートに解決する。
  `yuki` を足すと**分岐漏れで Yuki の明細が家庭用 `Data` に書かれる**危険があるため、レジストリ参照にし、
  未知 source は例外を投げる(既定値を持たない)。
- キャッシュキー(`gas/コード.js:186-196`)は source 名から生成されるため `kakeibo_yuki_{data|fixed}` / `kakeibo_yuki_gen` が
  自動で分離される。`clearCache('yuki')` は既存実装で動く(テストで確認)。
- `doGet`(`gas/コード.js:371`)/ `doPost`(`gas/コード.js:481`)の source 検証は共通関数のまま。
- シート作成: GAS エディタ関数 `setupSourceSheets('yuki')`(冪等)が `Yuki_Data`(A〜H 列見出し、H=`RowId`)、
  `Yuki_Config`、`Yuki_Fixed` を作る。既存シートがあれば何もしない。
- `backfillRowIds`(`gas/コード.js:853-855` の `['main','yahoo']`)をレジストリ全件に。`Yuki_Data` は最初から H 列採番済み。
- Next.js 側 `isAllowedSource`(`lib/expenses-proxy.ts:8`)もレジストリ参照にする。
- その他の「未指定なら main」への落ち込み箇所(すべて洗い出して扱いを決める):
  | 箇所 | 現状 | 方針 |
  | --- | --- | --- |
  | `getCacheSourceKey`(`gas/コード.js:187`) | `normalizeSource(source) \|\| 'main'` で、不正 source でも main のキャッシュキーになる | 正規化に失敗したら例外(呼び出し元は検証済み source のみ渡す前提をコードで強制) |
  | `getTargetSheets`(`gas/コード.js:142-155`)、LINE 宛先・ラベル(`gas/コード.js:1278-1284`) | `yahoo` 以外は main | 上記のとおりレジストリ参照・未知は例外 |
  | `processFixedCostsForSource()` 引数なし(`gas/コード.js:775`)と固定費 ID の `source \|\| 'main'`(`gas/コード.js:815`) | 未指定を main 扱い | ループで source を必ず明示して渡す。ID の書式は既存行との互換のため変えない |
  | `components/ExpenseDetailModal.tsx:24` | `source = 'main'` の既定値 | 既定値を削除し必須 prop にする(呼び出し元が渡し忘れると型エラー) |
  | `lib/api.ts:16-18`(`fetchExpenses`)、`hooks/useExpenses.ts:10`、各 View の `source?` | 省略時はクエリに source を付けず、プロキシ・GAS が main と解釈 | 内部 API は source 必須にし、main も `'main'` を明示して送る。プロキシ・GAS の「省略 = main」は旧クライアント互換としてのみ残し、§11 G5/U6 で削除を検討 |

### 5.2 固定費トリガー

- `processFixedCosts`(`gas/コード.js:774-777`)をレジストリの全 source でループし、source ごとに既存の
  `processFixedCostsForSource` を呼ぶ(source ごとに独立したロック。1つ失敗しても次へ進むよう try/catch)。
- 固定費 ID は `fixed_<YYYYMM>_<名称>_<source>`(`gas/コード.js:815`)で source を含むため `yuki` でも衝突しない。
- トリガー自体は既存の日次トリガー(エディタで設定、コード内に `newTrigger` は無い)をそのまま使う。

### 5.3 LINE 月次レポート

- `sendMonthlyKakeiboReports`(`gas/コード.js:1214-1217`)をレジストリでループ。現状は main で例外が出ると yahoo が送られない
  (逐次呼び出しで try/catch なし)ため、source ごとに try/catch し、宛先 Property 未設定の source は警告ログでスキップする。
- 宛先キー(`gas/コード.js:1278-1280`、`yahoo` 以外は MAIN に解決)とラベル(`gas/コード.js:1282-1284`)はレジストリ参照にする
  (未知 source が家庭用の宛先へ送られる分岐を無くす)。
- Yuki の宛先: Script Property `LINE_DESTINATION_YUKI`(値は §5.4 の連携で設定)。LINE チャネル(公式アカウント)は既存を共用し、
  Yuki はそのアカウントを友だち追加する(決定事項: 既存アカウントを共用)。月次レポートは1人1通/月なので、無料メッセージ数への影響は小さい(実装時に LINE の管理画面で現在のプランの上限を確認する)。

### 5.4 Yuki の LINE userId の取得方法

制約: LINE の userId は LINE 公式アカウントの管理画面には表示されず、webhook(またはプロフィール API)でしか得られない。
GAS の doPost は HTTP ヘッダを読めず `X-Line-Signature` を検証できない。現状 GAS は LINE webhook を無視している
(`gas/コード.js:473-476`、`isLineWebhookPayload` `gas/コード.js:1204-1210`)。署名を検証できない webhook の内容を
そのまま宛先に採用すると、偽の webhook で第三者の userId を Yuki の宛先として登録させられる。

| 案 | 方法 | 評価 |
| --- | --- | --- |
| **A. Vercel で署名検証 + 1回限りの連携コード + 本人確定(推奨)** | webhook URL を Next.js `/api/line/webhook` に変更し、`X-Line-Signature` を検証。Yuki がアプリで発行した連携コードを公式アカウントへ送ると候補として保留し、Yuki がアプリで連携先の LINE 表示名を確認して確定する(詳細は下記) | 署名で LINE 由来を保証し、コード+本人確定で「誰の LINE か」を保証する。新しい秘密(チャネルシークレット)が Vercel に1つ増える。webhook URL の変更が必要 |
| B. GAS webhook + 連携コード + 確認プッシュ | webhook は GAS のまま。コード一致の候補 userId を GAS が保留し、プロフィール API で友だちであることを確認、確認プッシュを送り、Yuki がアプリで表示名を確認して確定 | 署名なしでもコードの秘匿で概ね安全だが、手順が多く、偽 webhook の試行を防げない(コード総当たりは有効期限・試行回数制限で緩和) |
| C. 手動 | 管理者が一時的に webhook を記録用にして userId を読み取り Script Property に手入力 | 管理者が Yuki の userId を扱う。再連携のたびに管理者作業。非推奨 |

推奨は A。手順と安全策:

1. **コード発行**: Yuki が自分のセッション(source=yuki 権限)で「LINE 連携」を押すと、サーバーが連携コードを生成し、
   GAS `authCreateLineLinkCode` にハッシュ・userId・対象 source・有効期限(10 分)を保存する。
   - コードは**英数字 10 文字以上**(紛らわしい文字 `0 O 1 I l` を除いた32種から暗号学的乱数で生成。10 文字で約 50 ビット)。
   - 1利用者につき有効なコードは1つ(再発行で旧コードを無効化)。どの source の宛先になるかは発行時にサーバーが決め、webhook 側の入力では決めない。
2. **webhook 受信**(`/api/line/webhook`、middleware の公開パス。署名検証が認証の代わり):
   - `request.text()` で**生の本文**を受け取り、Vercel 環境変数 `LINE_CHANNEL_SECRET` による HMAC-SHA256(Base64)を
     `X-Line-Signature` と定数時間比較してから `JSON.parse` する(先に `request.json()` すると署名対象のバイト列が失われるため不可)。
     不一致は 401 で、本文はログに出さない。
   - テキストメッセージのうち連携コードの書式に一致するものだけを GAS `authLinkLine { code, lineUserId }` に渡す。その他は現行どおり無視。
3. **GAS での照合**(Script Lock 内):
   - コードのハッシュが一致し期限内なら、そのコードの**候補**として lineUserId を保留する(まだ宛先にしない)。
   - **コードごとの失敗回数**: コードの書式に一致したが照合に失敗した試行を、その時点で有効な全コードの失敗として数え、
     **3 回で有効なコードをすべて失効**させる(コードは推測困難なので、正規の利用者が3回間違えることはほぼ無い)。
   - **レート制限**: LINE userId ごとに 10 分あたり 5 回、全体で 10 分あたり 20 回を上限とし、超過分は照合せず無視する
     (カウンタは Script Cache。webhook には LINE 以外からの到達は署名で弾かれるため、主に正規の友だちからの総当たり対策)。
   - 照合結果に関係なく LINE への応答は 200(LINE の再送を起こさない)。返信(reply API)は成功時のみ「アプリで確定してください」。
4. **本人による確定**: Yuki のアプリの「LINE 連携」画面が保留中の候補を表示する。サーバーは LINE プロフィール API
   (`GET /v2/bot/profile/{userId}`、既存の `LINE_CHANNEL_ACCESS_TOKEN` を使い GAS から呼ぶ)で取得した**表示名**を見せ、
   Yuki が「これは自分の LINE」と確定したときだけ GAS `authConfirmLineLink` が `LINE_DESTINATION_YUKI` を設定する。
   違う場合は「取り消し」で候補とコードを破棄する。確定後に確認メッセージを push する。
   - 表示名は画面表示のみに使い、シート・ログには保存しない(lineUserId は宛先 Property にのみ保存)。

実装時の決定(G4):
- **コードは GAS が生成する**(`authCreateLineLinkCode` の応答で一度だけ返し、シートにはハッシュのみ)。招待トークンと同じ乱数源
  (`newRandomBytes`)を使え、コードの書式・長さを GAS の VM テストで保証できるため。呼び出しは `authKey` 付きの `/api/auth/line-link` に限られる。
- **失敗回数は LINE userId ごとに数える**(上記 3. の「全コード失効」は採らない): 全コード失効方式では、公式アカウントの友だちなら誰でも
  誤ったコードを3回送るだけで Yuki のコードを失効させられる(連携の妨害)。LINE userId ごとに 10 分で 3 回失敗したらその userId だけを
  ブロックし、総当たりは 50 ビットのコードと全体 20 回/10 分の制限で防ぐ(有効期間 10 分の間に当たる確率は無視できる)。
- 候補(lineUserId)はシートではなく Script Cache に保持する(照合から 10 分)。確定時に発行時と同じ条件(本人の `lineOptional` の source)を再確認する。

### 5.5 `updateCategory` の扱い

現状: `updateCategory` は要求 source に関係なく **main と yahoo の両方**の Data を店舗名一致で書き換え、両方の Config に
ルールを追加し、両方のキャッシュを消す(`gas/コード.js:676-720`、SPECIFICATION §2「両sourceで更新」)。

方針: **「カテゴリ共有グループ」∩「利用者の sources」に限定する**。

- グループ定義(GAS 定数): `[['main','yahoo'], ['yuki']]`。将来の利用者は自分の source 単独のグループ。
- 対象 source = 要求 source が属するグループ ∩ `actor` の sources。
  | 実行者(sources) | 要求 source | 書き換える Data | 書き換える / 追加する Config | 無効化するキャッシュ |
  | --- | --- | --- | --- | --- |
  | 管理者(main, yahoo) | main または yahoo | `Data` と `Yahoo_Data` | `Config` と `Yahoo_Config` | main, yahoo(既存挙動と同じ) |
  | Yuki(yuki, main) | main | `Data` のみ | `Config` のみ | main のみ |
  | Yuki(yuki, main) | yuki | `Yuki_Data` のみ | `Yuki_Config` のみ | yuki のみ |
  | 管理者 | yuki | (要求自体がプロキシ・GAS で 403 / `Forbidden`) | — | — |

  - Yuki が家庭用の店舗カテゴリを変えても、**管理者の個人用(`Yahoo_Data` / `Yahoo_Config`)は変更しない**(決定事項)。
    その結果、同じ店舗が家庭用と個人用で別カテゴリになり得る。管理者が後で同じ店舗を変更すれば従来どおり両方に揃う。
  - Config(自動分類ルール)も Data と同じ対象 source だけに書く。Yuki が main で変えたルールは、今後の家庭用(`Data`)への
    楽天カードの取込(`extractRakutenEmails` は `Config` を使う、`gas/コード.js:934-935`)に効く。`Yahoo_Config` には書かない。
  - Yuki の yuki での変更は `Yuki_Config` に入り、フェーズ2の Yuki の取込に効く。
- `actor` が無い移行期間の旧クライアントは従来どおり main+yahoo(yuki は旧クライアントから来ない)。
- キャッシュ無効化は対象 source ごとに `clearCache`。プロキシは従来どおり `expenses` タグを再検証。
- SPECIFICATION の API 契約表を「共有グループ内で利用者が権限を持つ source の同一店舗」に更新する。

### 5.6 認証情報用の新アクション

- 認証系は source を持たないため、`WRITE_ACTIONS`(`gas/コード.js:460-468`)とは別の `AUTH_ACTIONS` とし、
  doPost で source 検証より前に分岐する(すべて POST。秘密値を URL に載せない)。
- 共通: `PROXY_SECRET` 必須(未設定なら常に `Unauthorized`。移行期間の素通しを適用しない)。書き込みは Script Lock 内。
  認証系シートの変更時は認証用 Script Cache を無効化。応答に招待トークン・ハッシュを含めない。
- **認証系は `key` に加えて `authKey` 必須**(G3 レビューで追加): 現行本番の `/api/expenses` プロキシは本文を action の制限なしに
  転送して `key` を付け直すため、`key` だけでは「ログイン済みの任意のブラウザ」と区別できない(push 1〜push 2 の間に
  `authGetAdminUser` → `authAddCredential`(actor=管理者を自称、bootstrap)で管理者にパスキーを追加される等)。
  そこで GAS の Script Property `AUTH_PROXY_SECRET`(`PROXY_SECRET` とは別の値)を、本文の `authKey` と定数時間で照合する。
  Vercel 側は `GAS_AUTH_PROXY_SECRET` として **新しい `/api/auth/*` と actor を付与する経路だけ**が送る(旧プロキシは決して送らない)。
  `AUTH_PROXY_SECRET` 未設定、`authKey` の欠落・不一致はすべて `Unauthorized` で、何も読まず書かない。
  値が `PROXY_SECRET` と同じでも別フィールドとして照合する(`setupAuthSheets()` が同値・未設定を警告)。

| action | 用途 | 呼び出し元 | 主な入力 |
| --- | --- | --- | --- |
| `authGetAdminUser` | パスワードログイン時に管理者行(role=admin・active が1件)を取得 | auth/verify(パスワード、移行期間のみ) | なし |
| `authPeekInvite` | 招待の有効性確認(消費しない) | register/options | tokenHash |
| `authConsumeInviteAndAddCredential` | 招待消費+パスキー追加(原子的)+チャレンジ再利用確認 | register/verify | tokenHash, challengeHash, credential{...} |
| `authAddCredential` | 再認証済み本人のパスキー追加(epoch 照合、ブートストラップ時はパスキー0件を確認) | passkeys/add/verify | actor, challengeHash, credential, [bootstrap] |
| `authGetCredential` | credentialId → 公開鍵・カウンタ・ユーザー行 | login/verify、passkeys/add/reauth | credentialId |
| `authRecordCredentialUse` | lastUsedAt・カウンタ更新+チャレンジ再利用確認 | login/verify、passkeys/add/reauth | credentialId, counter, challengeHash |
| `authListCredentials` | 本人のパスキー一覧 | 本人画面 | actor |
| `authRevokeCredential` | 本人のパスキー失効 + epoch+1 | 本人画面 | actor, credentialId |
| `authBumpEpoch` | 本人の全端末ログアウト | 本人画面 | actor |
| `authCreateLineLinkCode` / `authLinkLine` / `authGetLineLinkCandidate` / `authConfirmLineLink` | LINE 連携(§5.4) | 本人 / webhook | actor, [source](コードは GAS が生成して返す、§5.4 実装時の決定) / code, lineUserId / actor / actor, decision |

Web アプリから呼べるのは上表のみで、**すべて本人(actor)に対する操作か、未ログイン時のログイン・登録用**である。
他人に対する操作(招待発行・他人のパスキー失効・他人の epoch 更新・ユーザー追加/無効化)は Web アクションとして公開せず、
GAS エディタから実行する関数にする(Google アカウント=シート所有者でしか実行できない):

| GAS エディタ関数 | 用途 |
| --- | --- |
| `setupAuthSheets()` | `Auth_*` シート作成と管理者行作成(冪等) |
| `addUser(displayName, sources, homeSource)` / `disableUser(user)` | 利用者の追加・無効化(無効化時は epoch +1) |
| `createInvite(user, purpose)` | 招待発行。URL は実行ログにのみ出力(§3.3) |
| `revokeCredential(user, credentialIdPrefix)` / `bumpEpoch(user)` | パスキー失効・全端末ログアウト |
| `listUsers()` | 利用者とパスキーの一覧(公開鍵は出さない)を実行ログへ |

role は当面 GAS 側だけで使う(`authGetAdminUser` が管理者行を特定するため)。Next.js には role による画面・API の分岐を設けない。

### 5.7 データアクションへの `actor` 照合

- プロキシは GET クエリ/POST 本文に `actorUserId` と `actorEpoch` を付与する(クライアント送信分は除去)。
  actor を付けるときは必ず `authKey`(`GAS_AUTH_PROXY_SECRET`)も付ける(§5.6)。
- GAS は `PROXY_SECRET` 照合 → source 検証 → `actor` 照合(ユーザー行が `active`、epoch 一致、source ∈ sources)の順で判定。
  actor のフィールドが1つでもあれば、`authKey` が `AUTH_PROXY_SECRET` と一致しない限り `Unauthorized`(旧プロキシ経由で
  ブラウザが actor を自称しても信頼しない)。actor 無しの main / yahoo は従来どおり `key` だけで通る。
  ユーザー表は Script Cache(認証系書き込みで無効化)から読み、ヒット時はシートを開かない。
- 移行フラグ(Script Property `AUTHZ_ENFORCE`):
  - 未設定: `actor` 無しの要求は main / yahoo のみ従来どおり許可(旧 UI 互換)。**`yuki` は常に `actor` 必須**。
  - `1`: すべてのデータ要求で `actor` 必須。
- Next.js の一覧キャッシュ(`unstable_cache`、キーはクエリ=source 単位、`app/api/expenses/route.ts:46-49`)は利用者間で共有される。
  プロキシが source 権限を確認してからキャッシュを読むので他人の source が漏れることはないが、epoch 失効は
  キャッシュヒットの間(最大5分)一覧読み取りに反映されない。許容する(書き込みは常に GAS を通るので即時)。
  `actorUserId` / `actorEpoch` はキャッシュキーに含めない(`toGasQuery` と同様、送信直前に付与)。

---

## 6. 不変条件への適合

| 不変条件(AGENTS.md) | 本設計での扱い |
| --- | --- |
| main / yahoo を混在させない(+ yuki) | source レジストリで 1 source = 1 組のシートを明示し、既定値への落ち込み(`getTargetSheets` の else、LINE 宛先の else)を廃止して未知 source は例外。プロキシ・GAS の両方で source と権限を検証。`updateCategory` は共有グループ ∩ 利用者の sources に限定(Yuki の main での変更は yahoo に及ばない)。main は管理者と Yuki が共有するが、シートは1組のまま(共有は権限の話で、データは混ぜない)。Next.js の localStorage キャッシュは既に source 別(`hooks/useExpenses.ts:25`)、ログアウト・ユーザー切替時に消去 |
| 明細1件の更新・削除で MessageId を信用しない | 既存の `rowId` + 厳密照合(`findTransactionRowIndex` `gas/コード.js:125-139`)を yuki でもそのまま使う。変更なし |
| 書き込み時のキャッシュ無効化 | yuki の書き込みは `clearCache('yuki')`、`updateCategory` は対象 source ごと。プロキシの `revalidateTag` は現行どおり。認証系は専用 Script Cache を無効化 |
| 集計ルール(`Income` のみ収入、空カテゴリは未分類) | 集計コード(`lib/expense-analysis` 等、GAS 月次レポート)は source 非依存で共用。変更なし |
| 秘密情報をリポジトリに置かない | 新規の秘密: `LINE_CHANNEL_SECRET`(Vercel)、`LINE_DESTINATION_YUKI`(GAS)。いずれも値はリポジトリに置かない。招待トークンはハッシュのみ保存。テストは架空の userId・鍵・ドメインを使う。この設計書にも実値を書かない |
| GAS API 契約変更時の同時更新 | §11 の各ステップで `gas/コード.js`・呼び出し側・テスト・SPECIFICATION を同一コミットで更新 |
| GAS → UI のデプロイ順 | §7。GAS コミットは旧 UI と互換(新規アクション追加と、`actor` 無しでも main/yahoo を許可)。本リリースは GAS と UI を別 push にし、間に `setupAuthSheets()` 等を実行 |

---

## 7. 移行・リリース手順

### 7.1 後方互換の原則

- 新 GAS + 旧 UI: 旧 UI は `actor` を送らないが、`AUTHZ_ENFORCE` 未設定なら main / yahoo は従来どおり動く。
  旧 UI は `yuki` も認証系アクションも呼ばない。`updateCategory` は actor 無しなら従来挙動。
- 新 UI + 旧 GAS: 起こさない(deploy.yml が GAS の新ビルド確認後に Vercel を出す。SPECIFICATION §8)。
- 新 UI + 新 GAS だが `setupAuthSheets()` 未実行: パスワードログインが `authGetAdminUser` で管理者行を得られず**全員ログイン不能**になる。
  これを避けるため、このリリースに限り GAS と UI を**別の push** にし、間にエディタ作業を挟む(次節)。

### 7.2 手順

SPECIFICATION §8 は「GAS 変更と UI 変更は同じ push に含めてかまわない」としているが、それは GAS デプロイ後に手作業が要らない場合の話である。
本リリースは GAS デプロイと UI デプロイの間に `setupAuthSheets()` の実行が必須なので、**例外として push を2回に分ける**
(SPECIFICATION の該当箇所にも「デプロイ後にエディタ作業を要する変更は push を分ける」と追記する)。

1. **事前(ユーザー作業)**: 本番ドメインは現状の Vercel ドメイン(決定事項)。LINE チャネルシークレットを用意(値は Vercel にのみ設定)。
   `PROXY_SECRET` / `GAS_PROXY_SECRET` が両側に設定済みであることを確認(未設定なら IMPROVEMENTS 4-1 の手順で先に設定。
   新しい認証系アクションは未設定だと全拒否になり、パスワードログインもできなくなるため)。
   Yuki に「管理者はシート所有者として技術的に見られる」ことを説明して了承を得る(ユーザー側タスク)。
   移行当日(手順 6〜9)の時間帯を Yuki と決めておく。
2. **push 1(GAS のみ)**: §11 の G1〜G4 を push → deploy.yml が GAS をデプロイし `?action=version` で確認。
   docs 以外の UI 変更を含めない(deploy.yml は Vercel にも再デプロイするが、UI は旧版のまま。旧 UI + 新 GAS は互換)。
3. GAS の Script Property に `AUTH_PROXY_SECRET`(`PROXY_SECRET` とは別の英数字の暗号学的乱数。例 `openssl rand -hex 32`)と
   `APP_ORIGIN`(`https://<本番ドメイン>`)を設定する(push 1 の後。旧 UI は `authKey` を送らないので影響しない)。
   GAS エディタで `setupAuthSheets()`(管理者行作成。`AUTH_PROXY_SECRET` の未設定・`PROXY_SECRET` との同値を警告)、
   `setupSourceSheets('yuki')`、`addYukiUser()`(= `addUser('Yuki', ['yuki','main'], 'yuki')`)を実行(冪等)。
   `listUsers()` で管理者行(main, yahoo)と Yuki 行(yuki, main)があることを確認する。
4. Vercel に `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` / `LINE_CHANNEL_SECRET` と、GAS の `AUTH_PROXY_SECRET` と同じ値の
   `GAS_AUTH_PROXY_SECRET` を設定。
5. **push 2(UI)**: §11 の U1〜U5 を1回で push → GAS は差分なしでスキップ、Vercel デプロイ。
   v1 Cookie は無効になる。ここから**移行期間**: パスワードでログインすると誰でも admin の v2 セッション(現状と同じ権限)。
6. 管理者が最初のパスキーを登録(パスワード再入力で再認証)→ 2つ目を1つ目で再認証して登録 → ログアウト → パスキーでログインできることを確認。
7. 続けて GAS エディタで `createInvite('Yuki', 'register')` を実行し、実行ログの URL を Yuki に渡す。
   Yuki が Safari で登録(iOS バージョンと iCloud キーチェーン保存を確認)→ ホーム画面に追加 → ホーム画面アプリでパスキーログイン
   → `/yuki` と家庭用の切替を確認 → LINE 連携(表示名を確認して確定)。
8. Yuki のログインを確認したら直ちにパスワードを廃止する(§3.10 手順5):
   Vercel から `APP_PASSWORD` を削除 → `deploy.yml` を `workflow_dispatch` で実行して再デプロイ(承認後。環境変数は再デプロイまで反映されない)
   → `/login` にパスワード欄が無い・`POST /api/auth/verify` が 404・移行期間のパスワードセッションが画面でも API でも拒否されることを確認
   → GAS エディタで `bumpEpoch(<管理者>)`。管理者はパスキーで入り直す。**移行期間ここまで**。以後の非常口は §3.9。
9. 動作確認(Yuki: yuki の手入力・固定費・統計、家庭用の閲覧・編集、`/yahoo` に入れない、API で `source=yahoo` が 403。
   管理者: `/yuki` に入れない、API で `source=yuki` が 403)後、GAS の Script Property `AUTHZ_ENFORCE=1` を設定(再デプロイ不要)。
   問題があれば Property 削除で即戻る。
10. 約2週間後、パスワードログイン・v1 互換・`AUTHZ_ENFORCE` 未設定時の互換コードを削除するコミット(§11 U6/G5)。

順序の理由(決定事項): Yuki も共有パスワードを使っているため、Yuki がパスキーで入れることを確認してからパスワードを廃止する(手順 7 → 8)。
その間(手順 5〜8)は Yuki がパスワードで入ると yahoo も見える admin セッションになるため、手順 5〜8 を同じ日に続けて行い、
移行期間を1日以内にする(§3.10)。

### 7.3 ロールバック

- UI: `npx vercel rollback`(SPECIFICATION §8)。旧 UI は v2 Cookie を拒否するため、全員パスワードでの再ログインが必要。
  **手順 8(パスワード削除)の前ならロールバック可能**。後なら `APP_PASSWORD` を一時的に再設定してからロールバックする。
  再設定したら再デプロイして反映し(この間は `amr=pwd` のセッションも再び有効になる)、復旧後は手順 8 と同じく
  削除 → 再デプロイ → 確認 → `bumpEpoch(<管理者>)` を行う。
  ロールバック中、Yuki はアプリを使えない(旧 UI は yuki を拒否)。Yuki のデータはシートに残る。
- GAS: `clasp deploy -V <前バージョン>`。旧 GAS は `yuki` を `Invalid source` で拒否し、認証系アクションを `Unknown action` で返すため、
  新 UI ではパスキーログインも不可になる。GAS だけ戻す場合は UI も同時に戻す。
- `AUTHZ_ENFORCE` は Property の削除で即時に戻せる。

---

## 8. テスト計画

この環境では E2E を実行できない。`node --test` の単体・GAS VM テストで網羅し、E2E はユーザー環境での手順のみ用意する。
実データは使わず、架空の userId・ドメイン・鍵・明細を使う。

### 8.1 単体(Next.js 側、`test/*.test.mjs`)

- セッション v2(`lib/session.ts`): 発行・検証の往復、sources / epoch / amr の復元、`APP_PASSWORD` 未設定時に `amr=pwd` を無効・`amr=pk` は有効、`amr` の改ざん(pwd→pk)で署名不一致、改ざん(各フィールド)、期限切れ、
  未来の発行時刻、長さ上限、v1 トークンの拒否、チャレンジ Cookie をセッションとして受理しないこと(鍵・書式の分離)。
- WebAuthn: ソフトウェア認証器(Node の `crypto` で ES256 鍵を生成し clientDataJSON / authenticatorData を組み立てる)で
  登録・認証の検証成功、origin / rpID / challenge 不一致、UV フラグなし、失効済みパスキー、別ユーザーの userHandle の拒否。
- 招待: トークンのハッシュのみ GAS へ送ること、フラグメントの扱い、期限切れ・使用済み時のエラー表示。
- パスキー追加: 再認証なし・再認証のチャレンジを登録に流用・別ユーザーのパスキーでの再認証をすべて拒否。パスキーを持つ利用者のパスワード再入力による代替を拒否。
- パスワードログイン: `authGetAdminUser` が管理者行を返したときだけ v2 発行。0件・複数・GAS 失敗・`Unauthorized` ではセッションを発行しない。
- `returnTo` 検証: `//evil`、`/\evil`、絶対 URL、権限外 source のパス → ホームへ。
- パス→source 対応(`lib/sources.ts`)と BottomNav のリンク生成(`/yuki` で yuki のタブ)、source 切替の表示条件(sources が2つ以上)と
  切替先ルート(同じタブを維持)、テーマ対応表(main / yahoo の置き換え前後でクラスが同じ、yuki は pink)。

### 8.2 プロキシ(`test/expenses-proxy.test.mjs` 拡張)

- `isAllowedSource` が `yuki` を受理、`Yuki` 等の表記ゆれを拒否。
- 権限外 source の GET / POST が 403 で GAS を呼ばないこと(fetch をモック)。
- クライアント送信の `actorUserId` / `actorEpoch` / `key` / `authKey` が除去され、セッション由来の値で上書きされること。
- `/api/expenses` の POST が `WRITE_ACTIONS` の許可リスト外(認証系 `auth*` を含む)を 400 で拒否し GAS を呼ばないこと。
- `authKey` は actor を付けた要求と `/api/auth/*` からの認証系呼び出しにだけ付き、`unstable_cache` のキー・ログ・応答に出ないこと。
- `actor*` が `unstable_cache` のキー(`toGasQuery` の結果)に含まれないこと、ログ・応答に秘密が出ないこと。
- GAS の `SessionRevoked` で 401 + Cookie 削除。
- `APP_PASSWORD` 未設定時、`amr=pwd` のセッションでの GET(`fresh` なし=Next.js キャッシュ経路を含む)・POST が GAS もキャッシュも読まずに 401。
- クライアント: `fetchExpenses` / `postWrite` が 401 を受けたら `kakeibo_` 始まりの localStorage を消去して `/login` へ。
  ログイン成功時、`kakeibo_user` が無い・別の userId なら消去してから記録、同じ userId なら消去しない。`/login?reason=session` で消去。

### 8.3 権限の境界テスト(middleware の判定関数を純粋関数として切り出して表駆動)

| 利用者 | `/` 等(main) | `/yahoo/*` | `/yuki/*` | `/admin/users`(存在しない) | `GET ?source=main` | `GET ?source=yahoo` | `GET ?source=yuki` | `POST updateCategory source=main` | `POST updateCategory source=yuki` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 管理者 | 許可 | 許可 | → `/` | 404 | 許可 | 許可 | 403 | 許可(main+yahoo) | 403 |
| Yuki | 許可 | → `/yuki` | 許可 | 404 | 許可 | 403 | 許可 | 許可(main のみ) | 許可(yuki のみ) |
| 未ログイン | → `/login` | → `/login` | → `/login` | → `/login` | 401 | 401 | 401 | 401 | 401 |

加えて、`APP_PASSWORD` 未設定時の `amr=pwd` セッション(sources=main,yahoo)は全列で「→ `/login`」/ 401(パスワード廃止後の移行期間セッション)。

ログイン後の既定遷移: 管理者 → `/`、Yuki → `/yuki`。`returnTo=/yahoo` を持つ Yuki のログインは `/yuki` へ。

加えて、公開パス(`/login`, `/invite`, `/api/auth/register/*`, `/api/auth/login/*`, `/api/line/webhook`, manifest・アイコン)が保護されないこと、
`/api/auth/passkeys/*`・`/api/auth/logout`・`/api/auth/line-link` が保護されること、`/loginX` のような類似パスが保護されること。

### 8.4 GAS VM テスト(`test/gas-*.test.mjs`、既存のサンドボックス方式)

- `normalizeSource('yuki')`、`getTargetSheets` が未知 source で例外、yuki のシート名。
- yuki の追加・更新・削除が `Yuki_Data` のみを変更し、`clearCache('yuki')` だけが走る(main / yahoo の世代トークン不変)。
- `actor` 照合: actor 無しで yuki → 拒否、epoch 不一致 → `SessionRevoked`、sources 外 → `Forbidden`、`disabled` → 拒否、
  `AUTHZ_ENFORCE=1` で actor 無しの main → 拒否、未設定で actor 無しの main → 許可。
- `updateCategory`: 管理者 actor + main/yahoo → main+yahoo(既存テストと同じ結果)、Yuki actor + main → `Data`・`Config` のみ
  (`Yahoo_Data`・`Yahoo_Config` と yahoo の世代トークンが不変)、Yuki actor + yuki → `Yuki_*` のみ、actor 無し → main+yahoo、
  いずれも他グループのシート・Config に書き込まないこと。
- 認証系: `PROXY_SECRET` 未設定で全拒否(`authGetAdminUser` を含む)、招待の1回限り(連続2回の消費で2回目失敗)、期限切れ、既存未使用招待の無効化、
  パスキー失効で epoch +1、他人を対象にした操作が Web アクションに存在しないこと、数式インジェクション文字の拒否、
  エディタ関数 `createInvite` が生トークンをシートに保存しないこと。
- `authKey`(旧プロキシ経由の攻撃): `key` だけの `authGetAdminUser` / `authAddCredential`(bootstrap 含む)/ `authRecordCredentialUse`
  (カウンタ最大化)/ `authRevokeCredential` と、actor 付きのデータ GET・POST が `Unauthorized` で何も読み書きしないこと。
  `authKey` 正なら通る、誤り・欠落・`AUTH_PROXY_SECRET` 未設定は拒否、`AUTH_PROXY_SECRET` が `PROXY_SECRET` と同値でも
  `key` は `authKey` として扱われないこと(setup で警告)、ログに `authKey` が出ないこと。
- 固定費: yuki の固定費 ID に `_yuki` が付く、ある source のロック失敗でも他 source が処理される。
- 月次レポート: `LINE_DESTINATION_YUKI` 未設定でもスキップして他 source は送信、宛先キーの対応、main の例外で yahoo が止まらない。
- LINE 連携: コードの書式(紛らわしい文字なし10文字)・1回限り・期限・1人1つ・source 固定、ハッシュ不一致の拒否、
  失敗3回でその LINE userId をブロック(本人のコードは有効のまま)、userId ごと・全体のレート制限、確定前は宛先 Property が変わらないこと、
  取り消しで候補破棄、main / yahoo の宛先を設定できないこと(発行時・改ざんされた行での確定時)、ログ・シートにコード・LINE userId・表示名・トークンが出ないこと。
- チャレンジ再利用: 同じ challengeHash の2回目が `ChallengeReused`。
- Next.js / GAS の source レジストリ一致検査。

### 8.5 webhook(Next.js)

- 正しい署名のみ受理(架空のチャネルシークレットで HMAC を生成)、署名なし・不一致・本文改ざん(JSON として等価でも空白が違う本文を含む)は 401、コード以外のメッセージは無視。
- 生本文(`request.text()`)で検証してから JSON 化していること(再シリアライズした本文で検証しないこと)。

### 8.6 E2E(ユーザー環境、実機)

`npm run test:e2e` の既存シナリオ(`test/auth.browser.mjs`)はパスワード前提のため、仮想認証器
(Chrome DevTools Protocol の WebAuthn ドメイン)を使う版に置き換える。加えて実機 iPhone で:
招待登録(Safari)→ ホーム画面追加 → ホーム画面アプリでログイン → 各画面 → ログアウト → 別ユーザーでログイン時に前ユーザーの
キャッシュが表示されないこと、を手動確認する。

---

## 9. フェーズ2 概要: NAS ワーカーによる Yuki のメール取込

### 9.1 現状の取込と振り分け(コード調査)

`runEmailExtraction`(`gas/コード.js:926-930`)が時間トリガーで3つの取込を順に実行する。いずれも **GAS 実行ユーザー(=管理者)の
Gmail** を `GmailApp.search` で検索する(`appsscript.json` の `executeAs: USER_DEPLOYING`)。

| 関数 | 検索条件 | パーサ | 保存先 |
| --- | --- | --- | --- |
| `extractRakutenEmails` | 楽天カードの送信元、件名「利用のお知らせ」、件名「速報版」を除外、`newer_than:5d`(`gas/コード.js:937`) | `parseEmailBody`(表形式と「利用日:/利用先:/利用金額:」形式) | **main**(`Data`) |
| `extractOliveEmails` | Vpass の送信元、件名「利用のお知らせ」、`newer_than:5d`(`gas/コード.js:1008`) | `parseOliveBody`(「◇利用日：」等) | **yahoo**(`Yahoo_Data`) |
| `extractJcbEmails` | JCB の送信元、件名「JCBカード／ショッピングご利用のお知らせ」、`newer_than:5d`(`gas/コード.js:1075`) | `parseJcbBody`(【ご利用日時】等、1通1件) | **yahoo**(`Yahoo_Data`) |

- 振り分けは「カード会社 = source」の固定対応(楽天 → 家庭用、三井住友 Olive・JCB → 個人用)。
- 重複判定は保存先シートの E 列 MessageId(Gmail のメッセージ ID)の有無(`getExistingMessageIds` `gas/コード.js:1166-1173`)。
  追加は `appendImportedRows`(`gas/コード.js:1126-1142`)がロック内で重複を除き RowId を採番、`clearCache(source)`。
- 既知の課題: 削除した明細が 5 日以内に再取込される(IMPROVEMENTS 4-3)。
- **個人用(yahoo)は NAS 化しない**(決定事項)。Olive・JCB の通知は管理者自身の Gmail に届き、現行の GmailApp 取込のまま使う。
  フェーズ2の対象は **Yuki のメールのみ**。Yuki のメールは管理者の Gmail に届かないため、GAS の GmailApp では読めない(GAS は管理者として実行)。

### 9.2 構成(決定: Yuki 本人の Gmail を NAS が IMAP で読む)

```text
NAS(TrueNAS Custom App: 1コンテナ)
  ingest-worker ──IMAP(993/TLS, Yuki が発行したアプリパスワード, EXAMINE のみ)──> Yuki の Gmail
       │
       └──HTTPS POST {action:'ingestEmail', source:'yuki'}──> GAS Web App ──> Yuki_Data
```

- 実行方式: TrueNAS Custom App(docker compose)。Node.js 24 + IMAP ライブラリ(例 `imapflow`、採用時にバージョンと最終リリース日を確認)。
  `restart: unless-stopped`。**受信ポートを開けない**(外向きの IMAP と HTTPS のみ)。NAS の変更は `NAS/AGENTS.md` の手順に従う。
- 画面の通り道には入らない: NAS 停止時は取込が遅れるだけで、閲覧・手入力は Vercel → GAS で継続。
- ポーリング: 5 分間隔(IMAP IDLE は使わない。接続時間を最小にするため、毎回接続 → 検索 → 取得 → 切断)。
  各回 `SINCE <今日-7日>` とカード会社の送信元で検索し、処理済み UID を状態ファイルに記録
  (UIDVALIDITY が変わったら全件再走査、重複は GAS 側で除外されるので安全)。

**アプリパスワードの性質(前提として明記)**: Gmail のアプリパスワードは範囲を絞れず、Yuki のアカウント全体
(全メールの読み書き・削除、SMTP での送信)に使える。これが管理者の NAS に置かれることは「管理者は Yuki のデータを見られない」
という目的と緊張関係にある。この方式はユーザーが選択した(決定事項)ため、以下を**必須要件**として設計・実装・運用に組み込む。

| # | 必須要件 | 実装・運用での担保 |
| --- | --- | --- |
| R1 | **Yuki 本人の同意** | 上記の性質(受信箱全体・送信の権限が管理者の NAS に保管される)を Yuki に説明し、明示の同意を得てから発行してもらう(ユーザー側タスク)。同意前はワーカーを起動しない |
| R2 | **読み取り専用** | IMAP は `EXAMINE`(読み取り専用でメールボックスを開く)のみ。imapflow なら `mailboxOpen(path, { readOnly: true })`(または `getMailboxLock(path, { readOnly: true })`)で EXAMINE になる。`SELECT`・`STORE`(既読化などのフラグ変更)・`COPY`/`MOVE`・`EXPUNGE`・`APPEND`・SMTP を**コードに含めない**。ライブラリの該当 API を呼ばないことをテストで検査(呼び出し箇所の静的検査と、モック IMAP サーバーで書き込み系コマンドが送られないこと) |
| R3 | **送信元での絞り込み** | 検索対象のメールボックスは INBOX ではなく Gmail の「すべてのメール」(フィルタでアーカイブされた通知も拾うため)。フォルダ名は表示言語に依存するので名前で指定せず、`LIST` の特殊用途属性 `\All` を持つメールボックスを特定して開く。検索は `FROM <Yuki のカード会社の送信元>` と `SINCE` を必ず付ける(送信元の許可リストはコード定数。空なら起動しない)。一致した UID のメールだけを取得し、他のメールのヘッダ・本文は取得しない。取得は `BODY.PEEK[]`(既読にしない) |
| R4 | **Yuki が個別発行し、いつでも失効可能** | Yuki が自分の Google アカウントで、この用途専用のアプリパスワード(名前例「kakeibo-nas」)を発行する。他用途と共用しない。Yuki は Google アカウントの「アプリ パスワード」からいつでも削除でき、削除すると即座に取込が止まる(IMAP 認証失敗 → ワーカーは再試行せず停止・通知)。この手順を Yuki に伝える |
| R5 | **本文を NAS のディスク・ログに残さない** | 本文はメモリ上で GAS に送るだけで、ファイル・一時ファイル・ログに書かない。IMAP ライブラリ自身のログ(imapflow の `logger`。既定ではプロトコルの内容を出し得る)は `logger: false` で無効化する。コンテナのログには UID・件数・結果コードのみ(件名・送信元アドレス・本文・金額を出さない)。状態ファイルは UIDVALIDITY と最終 UID だけ。エラー時のスタックトレースにも本文を含めない(例外メッセージを固定文言に置き換える) |
| R6 | **保管方法** | アプリパスワードと `INGEST_SECRET` は NAS のアプリ用データセット上の env ファイル(所有者のみ読取 `0600`、コンテナの実行ユーザーのみ)に置き、compose ファイル本体・リポジトリ・GAS・チャット履歴には置かない。Yuki から管理者への受け渡しは対面などで行い、メッセージアプリの履歴に残さない。データセットのスナップショットに残る点は、失効(R4)で無効化できることで許容する |
| R7 | **最小の接続** | IMAP の接続先は `imap.gmail.com:993`(TLS 必須、証明書検証あり)のみ。ポーリング間隔外は切断 |

- 管理者が触れる範囲: 技術的には NAS 上のアプリパスワードで Yuki の受信箱全体を読めてしまう。R1 の説明でこれを明示し、
  緩和は R2〜R7 と、Yuki がいつでも失効できること(R4)に依存する。
- **要確認**(初回設定時): Yuki のアカウントでアプリパスワードを発行できるか(2段階認証プロセスの有効化が必須。
  Google Workspace / 学校・職場アカウント、高度な保護機能プログラム利用時は発行できない場合がある)。
- 認証: `PROXY_SECRET` を流用せず、**`ingestEmail` 専用の `INGEST_SECRET`**(GAS Script Property、決定事項)。
  NAS が漏れても明細の閲覧・削除はできず、`ingestEmail` は `source: 'yuki'` 以外を拒否する。

不採用の代替案(b): 取込専用の Gmail アカウントを作り、Yuki が自分の Gmail にカード会社の送信元だけを自動転送するフィルタを設定し、
NAS は取込専用アカウントだけを読む。NAS が持つ権限をカード通知に限定できるが、Yuki の初回設定(転送先の確認・フィルタ)が要り、
転送で DKIM の検証や `X-GM-MSGID` が変わる。ユーザーが (a) を選んだため不採用。R1〜R7 の運用が難しくなった場合の移行先として残す。

### 9.3 `ingestEmail` 契約(案)

リクエスト(POST 本文):

```json
{
  "action": "ingestEmail",
  "key": "<INGEST_SECRET>",
  "source": "yuki",
  "message": {
    "id": "<安定したメッセージID>",
    "from": "<送信元アドレス>",
    "subject": "<件名>",
    "receivedAt": "2026-11-08T09:00:00+09:00",
    "textBody": "<プレーンテキスト本文(最大 200KB)>"
  },
  "worker": { "name": "nas-ingest", "version": "<commit>" }
}
```

GAS の処理:

1. `INGEST_SECRET` 照合、`source` が取込許可リスト(コード定数。フェーズ2では `yuki` のみ)に含まれるか。
2. `from` / `subject` を **source ごとに許可されたパーサ**に照合する。Yuki のカード会社が既存3社(楽天 → `parseEmailBody`、
   Vpass → `parseOliveBody`、JCB → `parseJcbBody`)なら既存パーサを再利用し、それ以外なら新パーサを追加する(カード会社は未確定、§10.3)。
   どれにも一致しなければ `{ "error": "NoParser" }`。
3. パース結果を `determineCategory`(source の Config)で分類し、既存の `appendImportedRows` で追加(ロック・重複除外・RowId・`clearCache`)。
4. 応答: `{ "success": true, "parsed": n, "added": m, "duplicates": k }` / `{ "error": "Busy" }` / `{ "error": "NoParser" }` / `{ "error": "Unauthorized" }`。

冪等性:

- E 列 MessageId に `message.id` を入れ、同じ id の再送は `added: 0`。
- id は **RFC 822 `Message-ID` ヘッダの SHA-256(先頭に `imap:`)**。`Message-ID` が無いメールは Yuki のメールボックス内で一意な
  `X-GM-MSGID` を使う(先頭に `gmid:`)。Yuki のメールは GmailApp 取込の対象になったことがないため、既存 id 体系との重複・併用期間の問題は無い。
  初回は `SINCE` を運用開始日にし、それ以前の明細は手入力済みとして扱う(過去分の取込を希望する場合のみ範囲を広げる)。
- 削除した明細の復活(IMPROVEMENTS 4-3)を防ぐため、処理済み id を明細とは別の `Ingest_Log` シートに記録し重複判定に使う
  (フェーズ2で 4-3 と同時に対応)。

障害時の挙動:

| 事象 | 挙動 |
| --- | --- |
| GAS が `Busy` / 5xx / タイムアウト | 状態(処理済み UID)を進めず、指数バックオフで再試行。重複は GAS が除外 |
| `NoParser` | 処理済みとして記録しスキップ(件名・送信元のみログ。本文はログに出さない) |
| `Unauthorized` | 取込を停止し、エラー状態を記録(シークレット不一致は再試行しても直らない) |
| IMAP 認証失敗(Yuki がアプリパスワードを削除、パスワード変更で失効) | 再試行せず停止し、Yuki の LINE と管理者の LINE に「取込が停止しました」とだけ通知(R4)。再開は Yuki が新しいアプリパスワードを発行して管理者が差し替える |
| NAS 停止 | 再開時に `SINCE 7日` の範囲で追いつく。7日を超える停止は手入力または範囲拡大で補完 |
| 監視 | GAS が最終取込時刻を記録し、24 時間以上更新が無ければ管理者の LINE に通知(件数・明細内容は含めない) |

yahoo の取込(`extractOliveEmails` / `extractJcbEmails`)と main の取込(`extractRakutenEmails`)は現行の GmailApp のまま変更しない。
NAS ワーカーは Yuki のメールだけを扱い、`Data` / `Yahoo_Data` には書かない(`ingestEmail` が `yuki` 以外を拒否)。

---

## 10. リスク・決定事項・残る確認事項

### 10.1 リスク

| リスク | 影響 | 対策 |
| --- | --- | --- |
| RP ID がドメインに固定 | ドメイン変更・NAS 移行で全パスキーが無効 | 現状の Vercel ドメインで確定(決定事項)。将来変更する場合は再招待 / Related Origins |
| **パスワード廃止までの移行期間** | Yuki がパスワードでログインすると管理者権限のセッション(yahoo も見える。現状と同じ)になる。Yuki の端末の localStorage に yahoo の明細キャッシュが残り得る | 手順 5〜8 を同日に続けて行い1日以内に終える。廃止後は middleware・プロキシが `amr=pwd` のセッションを拒否(画面・API・Next.js キャッシュ経路とも)、補助として管理者の epoch を上げて GAS でも拒否。401 受信時・利用者変更時(以前の記録が無い端末を含む)に localStorage を消去。移行期間中は yahoo を開かないよう Yuki に依頼(§3.8、§3.10、§7.2) |
| Yuki の main での `updateCategory` | 同じ店舗が家庭用と個人用で別カテゴリになる | 仕様として明記(決定事項)。管理者が変更すれば従来どおり両方に揃う(§5.5) |
| `getTargetSheets` 等の既定値分岐 | yuki が家庭用シートに書かれる | レジストリ化・未知 source は例外・テスト(§5.1) |
| 管理者のパスキー全損 | ログイン不能 | 2つ以上登録、GAS エディタの非常口(§3.9) |
| ログインの GAS 往復(コールド 1〜3 秒) | ログインが遅い | 30 日セッション。options は GAS 不要 |
| 一覧キャッシュ中は epoch 失効が読み取りに最大5分反映されない(middleware・プロキシは epoch を見ない) | パスキーの失効・全端末ログアウト直後の閲覧 | 許容(書き込みは即時)。パスワード廃止時の失効は epoch ではなく `amr=pwd` 拒否で即時に効かせる(§3.8)。必要なら失効時に `revalidateTag('expenses')` |
| iOS PWA と Safari のストレージ分離 | 登録後に再ログインが必要 | 案内文言 |
| LINE 内ブラウザで招待を開く | 登録失敗 | Safari で開く案内 |
| `PROXY_SECRET` 未設定の素通し | yuki・認証系が無防備 | yuki・認証系は未設定時に拒否、4-1 残課題を先に解消 |
| 管理者による技術的閲覧・なりすまし | Yuki のプライバシー | 仕様として明記、パスキー追加時に Yuki へ LINE 通知 |
| フェーズ2のアプリパスワード(採用した方式 (a)) | Yuki の受信箱全体と送信の権限が管理者の NAS に置かれ、「管理者は Yuki のデータを見られない」と緊張関係にある | 必須要件 R1〜R7(Yuki の同意、EXAMINE のみ、送信元での絞り込み、Yuki による個別発行・いつでも失効、本文を残さない、保管方法、最小の接続)。運用が難しくなれば代替案 (b) へ移行(§9.2) |

### 10.2 決定事項(2026-11-08 ユーザー回答)

| # | 項目 | 決定 | 反映先 |
| --- | --- | --- | --- |
| D1 | 共有パスワードの利用者と権限 | Yuki も共有パスワードを使っている。移行後は管理者 = [main, yahoo]、Yuki = [yuki, main](家庭用は共有、個人用は管理者のみ、yuki は Yuki のみ) | §2.2、§4、§5.5、§8.3 |
| D2 | パスワード廃止の順序 | 管理者パスキー登録 → Yuki 招待・登録確認 → パスワード廃止。移行期間はリスクとして明記し1日以内に短縮 | §3.10、§7.2、§10.1 |
| D3 | 本番ドメイン | 現状の Vercel ドメインのまま | §3.5 |
| D4 | ID | `yuki`(source ID・`/yuki`・`Yuki_*`・`LINE_DESTINATION_YUKI`) | §2.2、§5 |
| D5 | スプレッドシートの共有 | 共有していない。`Auth_*`・`Yuki_*` は既存スプレッドシート内 | §3.7 |
| D6 | シート所有者による技術的閲覧 | 仕様として明記し、Yuki に説明して了承を得る(ユーザー側タスク) | §2.4、§7.2 |
| D7 | 招待リンクの有効期限 | 24 時間 | §3.3 |
| D8 | LINE 公式アカウント | 既存を共用し、Yuki が友だち追加。webhook を Vercel に移して署名検証 | §5.3、§5.4 |
| D9 | Yuki のカテゴリ | 共通カテゴリ(`lib/categories.ts`) | §1.4 |
| D10 | Yuki の画面テーマ | 淡いピンク(ライト系) | §4.4、§4.5 |
| D11 | Yuki の端末 | iOS 16 以上・iCloud キーチェーン有効の見込み(前提)。初回登録時に確認 | §3.9、§3.11、§7.2 |
| D12 | Yuki が利用をやめた場合 | `Yuki_*` のデータを Yuki に渡してから削除する。あわせて `disableUser` と epoch 更新、`LINE_DESTINATION_YUKI` の削除、フェーズ2のワーカー停止とアプリパスワードの削除依頼 | §5.6、§9 |
| D13 | フェーズ2の Yuki のメール | (a) Yuki 本人の Gmail を NAS が IMAP(アプリパスワード)で読む。緩和策 R1〜R7 を必須要件にする。(b) は不採用の代替案 | §9.2 |
| D14 | 個人用(yahoo)の NAS 化 | しない。yahoo は現行の GmailApp 取込のまま。フェーズ2の対象は Yuki のみ | §1.3、§9 |
| D15 | フェーズ2の NAS 認証 | 取込専用シークレット `INGEST_SECRET` | §9.2、§9.3 |

### 10.3 残る確認事項

1. 【フェーズ2】Yuki のカード会社はどこですか?(既存パーサは楽天・三井住友 Olive・JCB。それ以外なら新パーサを追加)
2. 家庭用(main)の LINE 月次レポートの宛先は、現状どおり管理者のみ(`LINE_DESTINATION_MAIN`)でよいですか、Yuki にも送りますか?
   **仮回答: 現状維持(管理者のみ)**。Yuki にも送る場合は、宛先を複数持てるようにする(例: `LINE_DESTINATION_MAIN` をカンマ区切り、
   または main のレポートを Yuki の連携済み宛先にも送る設定)小さな GAS 変更を追加する。

将来課題(今回は実装しない):

- 家庭用(main)を2人で編集するため、誰がいつ何を変更したかの記録(変更ログ)。実装する場合は専用の変更ログシート(例 `Change_Log`: 日時・userId・source・action・rowId・変更前後の値)に書き、
  明細シートの H 列(RowId)より右に列を足さない(列位置に依存する既存処理への影響を避ける)。

ユーザー側タスク(質問ではなく、実施が必要なこと):

- Yuki に「管理者はシート所有者として Yuki のデータを技術的に見られる」ことを説明し、了承を得る(フェーズ1の Yuki 招待前)。
- 【フェーズ2】Yuki にアプリパスワードの性質(受信箱全体と送信の権限が管理者の NAS に保管される)と失効方法を説明し、同意を得る(R1。ワーカー起動前)。

実装・初回設定時に確認すること(ユーザーへの質問ではない):

- Yuki の iPhone の iOS バージョンと iCloud キーチェーンへのパスキー保存(初回登録時)。
- Yuki のアカウントでアプリパスワードを発行できるか(フェーズ2の初回設定時)。
- LINE 公式アカウントの現在のプランのメッセージ上限。

---

## 11. 作業分割(フェーズ1)

規模の目安: S = 半日以内、M = 1日程度、L = 2〜3日。各コミットで `npm test` / `npm run lint` / `npm run build` を実行し、
GAS 変更は kakeibo-gas SKILL の手順に従う。

push の分け方(§7.2): このリリースは SPECIFICATION §8 の「GAS と UI を同じ push にしてよい」の**例外**とし、
**push 1 = GAS コミットのみ** → GAS エディタで `setupAuthSheets()` 等を実行 → **push 2 = UI コミット U1〜U5 をまとめて1回**、の順にする
(いずれもユーザーの承認後)。push 2 は1回で出すが、万一途中のコミットまでしか出なかった場合にも
ログイン不能にならないよう、パスワードでの v2 セッション発行はセッション v2 と同じ U2 に含める(U2 以降のどの時点でもパスワードでログインできる)。

### push 1: GAS コミット(旧 UI と互換)

| # | 内容 | 規模 |
| --- | --- | --- |
| G1 | source レジストリ化(`SOURCES`、`normalizeSource`、`getTargetSheets`・`getCacheSourceKey`・LINE 宛先/ラベルの既定値廃止、`backfillRowIds`、固定費・月次レポートのループと source ごとの try/catch)、`yuki` 追加、`setupSourceSheets`。VM テスト追加。SPECIFICATION のデータソース表・Script Properties 更新 | M |
| G2 | `actor` 照合(Script Cache 上のユーザー表、epoch、`AUTHZ_ENFORCE`、yuki は actor 必須)、`updateCategory` の共有グループ ∩ 利用者 sources 化(Yuki の main 変更は `Data`・`Config` のみ)。VM テスト。SPECIFICATION の API 契約・認証節 | M |
| G3 | 認証系(`Auth_*` シート、`authGetAdminUser`、招待の原子的消費、パスキー取得・記録・追加・失効、チャレンジ再利用記録、epoch)と GAS エディタ関数(`setupAuthSheets` / `addUser` / `disableUser` / `createInvite` / `revokeCredential` / `bumpEpoch` / `listUsers`)。`PROXY_SECRET` 未設定時の拒否。VM テスト | L |
| G4 | LINE 連携(`authCreateLineLinkCode` / `authLinkLine` / `authGetLineLinkCandidate` / `authConfirmLineLink`、LINE userId ごとの失敗3回ブロック(§5.4 実装時の決定)、userId ごと・全体のレート制限、プロフィール API、`LINE_DESTINATION_YUKI` の設定)。VM テスト | M |

### push 2: UI コミット(push 1 のデプロイ確認と `setupAuthSheets()` 実行の後)

| # | 内容 | 規模 |
| --- | --- | --- |
| U1 | `lib/sources.ts`(テーマ定義を含む)、`lib/theme.ts`(accent ごとのクラス対応表)と各 View の indigo 直書きの置き換え、`isAllowedSource` の yuki 対応、`/yuki` 配下ページ・layout(淡いピンクの背景・themeColor)・`yuki-manifest.json`、BottomNav / Dashboard / ManageView のレジストリ化、`ExpenseDetailModal` / `fetchExpenses` / `useExpenses` の source 必須化。レジストリ一致テスト。(この時点では旧 v1 セッションのまま。yuki は GAS が actor 無しを拒否するので読めない) | M |
| U2 | セッション v2(`readSession`、`amr` と `APP_PASSWORD` 未設定時の `pwd` 拒否)、401 時・利用者変更時の localStorage 消去、**パスワードログインを `authGetAdminUser` による admin の v2 発行に変更**(定数時間比較、`APP_PASSWORD` 未設定で無効化)、middleware の「公開パス以外は保護」+ source 判定(純粋関数化して表駆動テスト)、プロキシの 403・`actor` 付与・`SessionRevoked` 処理、ログアウトと localStorage 消去、`returnTo` 検証。**`/api/expenses` は POST の action を `WRITE_ACTIONS` の許可リストに限定し、クライアント由来の `actorUserId` / `actorEpoch` / `key` / `authKey` を除去してから、actor を付けるときだけ `authKey`(`GAS_AUTH_PROXY_SECRET`)を付ける。認証系 action は `/api/auth/*` からのみ `authKey` 付きで呼ぶ**(§5.6) | L |
| U3 | パスキー登録・ログイン・追加(再認証必須、ブートストラップはパスワード再入力)の API と画面(`@simplewebauthn/*` 固定版追加、`/invite`、`/login` 改修、`/settings/passkeys`)、チャレンジ Cookie。ソフトウェア認証器テスト | L |
| U4 | 本人のパスキー一覧・失効・全端末ログアウト、パスキー追加時の LINE 通知呼び出し | S |
| U5 | LINE webhook(`/api/line/webhook`、生本文での署名検証、連携コード転送)と Yuki の「LINE 連携」画面(コード発行・表示名の確認と確定) | M |

### 後続(安定後、目安2週間)

| # | 内容 | 規模 |
| --- | --- | --- |
| U6 | パスワードログイン・v1 互換の削除、E2E を仮想認証器版へ置換。**実施済み(2026-11)**: パスワードログイン・bootstrap のコード無効化(§3.10 手順6)。あわせて招待画面のアプリ内ブラウザ修正(§3.11)とアプリロック(§3.12)。**残り**: E2E(`test/*.browser.mjs`)の仮想認証器版への置換 | S |
| G5 | `AUTHZ_ENFORCE` 未設定時の互換と `PROXY_SECRET` 未設定時の素通しを削除(IMPROVEMENTS 4-1 完了)。U6 と別 push で GAS 先行 | S |

ドキュメント: 各ステップで SPECIFICATION・CODEMAP を更新し、完了時に IMPROVEMENTS に記録する。
本設計書は実装完了後に「実装済み」と状態を更新し、正本は SPECIFICATION とする。
