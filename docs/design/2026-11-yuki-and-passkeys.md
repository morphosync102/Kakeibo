# 設計書: Yuki 用家計簿の追加とパスキー認証への移行

- 作成日: 2026-11-08
- 状態: **ドラフト(計画段階・未実装)**。レビューとユーザー確認後に実装する
- 関連: [AGENTS.md](../../AGENTS.md) / [SPECIFICATION.md](../SPECIFICATION.md) / [CODEMAP.md](../CODEMAP.md) /
  [IMPROVEMENTS.md](../IMPROVEMENTS.md) / [kakeibo-gas SKILL](../../.agents/skills/kakeibo-gas/SKILL.md)

表記: 既存コードの事実は `ファイル:行` で根拠を示す(2026-11-08 時点の `main` = `eb19be0`)。
推測・未確認の事項は **要確認** と明記する。秘密値・実在の ID・実ドメインは記載せず `<本番ドメイン>` 等のプレースホルダで書く。

---

## 1. 目的・スコープ

### 1.1 目的

1. 新しい利用者「Yuki」が、自分の iPhone で自分専用の家計簿(source `yuki`)を使えるようにする。
2. ログインを共有パスワード(`APP_PASSWORD`)から、利用者ごとのパスキー(WebAuthn / Face ID)へ移行する。
3. 「ユーザー × 閲覧可能 source」の汎用モデルを導入し、将来の利用者追加をコード変更最小で行えるようにする。

### 1.2 フェーズ1(本書で詳細設計)

- 利用者・権限モデル(ユーザー表、セッションへの埋め込み、middleware / プロキシ / GAS の三段強制)
- パスキー登録(招待リンク)・ログイン・セッション・失効・復旧・管理者ブートストラップ
- source `yuki` の追加(`Yuki_Data` / `Yuki_Config` / `Yuki_Fixed`)。機能は個人用(yahoo)と同等:
  ダッシュボード / カレンダー / 統計 / 管理(手入力・固定費)、固定費の自動登録、LINE 月次レポート(Yuki 本人の LINE 宛)
- `/yuki` 配下の画面、BottomNav・PWA manifest の source 対応、権限外 URL の挙動
- アカウント管理(招待発行・パスキー失効・全端末ログアウト)は **GAS エディタから実行する関数**で行う
  (専用の管理画面は作らない。利用者が2人の間は過剰なため。§5.6)
- **既存 GAS(`gas/コード.js`)を作り直さず拡張する**

### 1.3 フェーズ2(概要のみ、§9)

NAS 上のワーカーが IMAP でメールを読み、GAS の新アクション `ingestEmail` に本文を渡して既存パーサ・重複除外・RowId 採番・ロックで取り込む。
対象は Yuki のカード通知と、目的が確認できれば個人用(yahoo)のカード通知(§9.1)。

### 1.4 非スコープ

- データストアの移行(Sheets → DB)、ホスティングの移行(Vercel → NAS)。ただし RP ID がドメインに縛られる点は §3.5 / §10 で扱う
- Yuki のメール自動取込(フェーズ2)。フェーズ1の Yuki は手入力と固定費のみ
- 管理者が Yuki のデータを**技術的に**見られなくすること(シート所有者は管理者。§2.4)
- 複数人での1つの source の共同編集時の競合 UI(既存の write-queue / Script Lock の範囲で扱う)
- E2E(Playwright)の実行。この作業環境では不可(§8)。ユーザー環境での実施手順のみ示す
- カテゴリ体系の source 別化(Yuki 専用カテゴリ)。必要なら別タスク(§10 の質問)

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
| sources | 閲覧・編集可能な source の集合(`main,yahoo` / `yuki`) |
| homeSource | ログイン後の既定 source |
| epoch | 権限版数(整数)。権限変更・全端末ログアウト・端末失効時に +1。セッションに埋め込み、GAS で照合 |
| status | `active` / `disabled` |
| createdAt / updatedAt | 日時 |

初期データ(値はイメージ):

| displayName | role | sources | homeSource |
| --- | --- | --- | --- |
| 管理者 | admin | main, yahoo | main |
| Yuki | member | yuki | yuki |

「管理者は Yuki のデータを見られない」は **role ではなく sources で決まる**(admin も `yuki` を持たない)。
role=admin はデータ閲覧権限とは独立で、当面は GAS 側でパスワードログイン時の管理者行の特定にのみ使う。

**source レジストリ**(コードに持つ。データではない)

| source | 画面ルート | シート | LINE 宛先 Property | テーマ |
| --- | --- | --- | --- | --- |
| `main` | `/`, `/statistics`, `/calendar`, `/manage` | `Data` / `Config` / `Fixed` | `LINE_DESTINATION_MAIN` | ライト |
| `yahoo` | `/yahoo/...` | `Yahoo_*` | `LINE_DESTINATION_YAHOO` | ダーク |
| `yuki` | `/yuki/...` | `Yuki_*` | `LINE_DESTINATION_YUKI` | 要確認(§10) |

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
   - 有効期限: **24 時間**(要確認。短くするほど安全)。1回限り。同一ユーザーの未使用招待は新規発行時に無効化。
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
  値は本番の `<本番ドメイン>`(例: `<project>.vercel.app` 形式)。
  - `vercel.app` は Public Suffix List に載っているため、RP ID は `vercel.app` にできず、完全なホスト名にする必要がある。
- **パスキーは RP ID に縛られる**。将来ドメインを変える(独自ドメイン取得、IMPROVEMENTS「ホスティング比較」C/D の NAS 移行)と
  全員のパスキーが使えなくなる。緩和策: 新ドメインで再登録(招待)するか、WebAuthn Related Origin Requests
  (`/.well-known/webauthn`)を使う(要確認: iOS Safari の対応状況)。**フェーズ1の前に本番ドメインを確定する**(§10)。
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

推奨は A。シートは既存スプレッドシート内に置く(`SHEET_ID` を共用)。ただし、スプレッドシートを他者と共有している場合は
別スプレッドシート(Script Property `AUTH_SHEET_ID`)に分ける(§10 で確認)。

`Auth_Credentials` 列: credentialId(base64url)、userId、publicKey(base64url COSE)、counter、transports、
deviceType、backedUp、label(例「iPhone」)、createdAt、lastUsedAt、revokedAt。
`Auth_Invites` 列: inviteId、tokenHash、userId、purpose、expiresAt、createdBy、usedAt。
全シートで数式インジェクション対策として値の先頭 `= + - @` を拒否する(IMPROVEMENTS 7-2 と同じ方針)。

### 3.8 セッション

- 既存の HMAC 方式(`lib/session.ts`)を拡張し、**v2 トークン**を導入する:
  `v2.<issued>.<expires>.<nonce>.<userId>.<epoch>.<sources>.<sig>`(sources は `main+yahoo` のように連結。role は Next.js で使わないため含めない)。
  - 有効期間は現行と同じ 30 日(`lib/session.ts:3`)。長さ上限 256(`lib/session.ts:32`)は 512 に拡張。
  - `verifySession` は真偽値ではなく `{ userId, epoch, sources } | null` を返す `readSession` に置き換える。
  - Cookie 属性は現行どおり HttpOnly / SameSite=Strict / Path=/ / 本番 Secure(`app/api/auth/verify/route.ts:23-29`)。
- 失効方法:
  | 対象 | 方法 | 反映 |
  | --- | --- | --- |
  | 1 利用者の全端末 | `epoch` を +1(本人の「全端末からログアウト」、GAS エディタ関数 `bumpEpoch`、権限変更、パスキー失効時に自動) | 書き込みは即時。一覧読み取りは Next.js キャッシュ(最大5分、`app/api/expenses/route.ts:45`)の間は旧 Cookie でも返り得る(§5.7) |
  | 1 パスキー | `revokedAt` を設定(以後そのパスキーでログイン不可)+ epoch +1 | 同上 |
  | 全員 | `SESSION_SECRET` のローテーション(現行どおり) | 即時 |
  | ログアウト(自分) | `POST /api/auth/logout` で Cookie 削除 + localStorage の `kakeibo_expenses_cache*` を消去 | 即時(端末内) |
- ログアウトは現状存在しない(`grep logout` で該当なし)。共用端末で他人の明細キャッシュ
  (`hooks/useExpenses.ts:8,25` の localStorage)が残るため、ログアウト時と「別ユーザーでログインした時」に
  `kakeibo_` で始まる localStorage を消去する。
- v1 Cookie の扱い: v2 導入時点で無効とし、管理者はパスワードで再ログイン(移行期間のみ)。

### 3.9 複数端末・機種変更・紛失時の復旧

- 各利用者は**パスキーを2つ以上**持つことを推奨(iPhone の iCloud キーチェーン同期 + もう1台の Apple 端末、
  またはハードウェアキー)。本人のパスキー画面に「パスキーが1つだけです」の注意を表示する。
- 機種変更: iCloud キーチェーン同期パスキーは同じ Apple ID の新しい iPhone に自動で移るため、操作不要(要確認: Yuki の
  iCloud キーチェーン有効化)。同期されない場合は復旧招待で再登録。
- 紛失・盗難: 本人(別端末でログインできれば)または管理者が GAS エディタ関数 `revokeCredential` で該当パスキーを失効
  (epoch +1 で全セッション失効)→ 管理者が `createInvite(..., 'recovery')` → 新端末で登録。
  - 紛失端末は Face ID / パスコードが無いとパスキーを使えないが、ログイン済みセッション Cookie は epoch 失効まで有効なので即失効させる。
- **Yuki のアカウントにパスキーが追加された時**、Yuki の LINE(連携済みなら)へ「新しい端末が登録されました」を送る
  (管理者による招待悪用の可視化)。
- 管理者自身が全パスキーを失った場合の非常口: 通常の招待と同じ GAS エディタ関数 `createInvite(<管理者>, 'recovery')`
  (有効期限は 10 分に短縮)。URL は実行ログにのみ出る(Google アカウント=シート所有者でしか実行できない)。
  `APP_PASSWORD` の再設定は非常口にしない(パスワードログインのコードは最終的に削除するため)。

### 3.10 管理者の初回ブートストラップとパスワード廃止

1. GAS で `setupAuthSheets()`(エディタ実行、冪等)が `Auth_*` シートを作成し、管理者ユーザー行(role=admin、sources=main,yahoo)を作る。
2. UI リリース後、管理者は既存の `APP_PASSWORD` でログインする。パスワードログインは**管理者ユーザーの v2 セッションのみ**を発行する
   (Yuki がパスワードを知っても admin 扱いになるため、Yuki 招待より前にパスワードを廃止するのが理想。§7)。
   - パスワード照合(定数時間に変更。現状 `===`、`app/api/auth/verify/route.ts:19`、IMPROVEMENTS 7-1)の成功後、
     GAS の新アクション **`authGetAdminUser`**(`PROXY_SECRET` 必須、未設定なら `Unauthorized`。入力なし)で
     role=admin かつ `active` のユーザー行(userId・epoch・sources)を1件取得し、その値で v2 セッションを発行する。
     管理者行が無い・複数ある・GAS が失敗した場合はログイン失敗(500 / 503)とし、**ユーザー情報なしのセッションは発行しない**。
   - このため `setupAuthSheets()` の実行(管理者行の作成)は UI リリースより前に必須(§7.2)。
3. 管理者が「パスキーを追加」で最初のパスキーを登録する。このときだけ再認証は **`APP_PASSWORD` の再入力**で代替する(§3.3)。
   2台目以降は1台目のパスキーで再認証して追加する。
4. パスキーでログインできることを確認したら、Vercel から `APP_PASSWORD` を削除する。コードは `APP_PASSWORD` 未設定時に
   パスワードログインを 404 にし、画面からも入力欄を消す。
5. Yuki を招待する(§7 の順序)。
6. 安定後(目安 2 週間)、パスワードログインのコードと v1 互換を削除するコミットを出す。

### 3.11 PWA(ホーム画面アプリ)での動作

- iOS 16 以降、ホーム画面に追加した Web アプリ(standalone)でも WebAuthn / パスキーが使える(要確認: 実機 iOS バージョンでの確認)。
- iOS のホーム画面アプリは Safari と Cookie / localStorage が分離される(要確認: iOS 17 以降の挙動)。
  パスキー自体は iCloud キーチェーンにあるため、Safari で登録 → ホーム画面アプリで再度「パスキーでログイン」すればよい。
  登録完了画面にこの案内を出す。
- 招待リンクは Safari で開く前提(LINE 内ブラウザ等ではパスキー登録が失敗し得る)。`/invite` で
  アプリ内ブラウザを検知したら「Safari で開いてください」と表示する(要確認: 判定方法)。
- manifest の `scope` は `/` にする。`/yuki` に限定すると `/login` 等が scope 外になり iOS がブラウザ UI を出すため。

---

## 4. 画面とルーティング

### 4.1 ルート

| パス | 対象 | 実装 |
| --- | --- | --- |
| `/yuki`, `/yuki/statistics`, `/yuki/calendar`, `/yuki/manage` | source=yuki | `app/yahoo/*` と同形。既存コンポーネントに `source="yuki"` と `isDarkMode` 等を渡す(`app/yahoo/page.tsx:4` 等と同じ) |
| `app/yuki/layout.tsx` | Yuki 用メタデータ | `manifest: "/yuki-manifest.json"`、`appleWebApp.title`、アイコン、背景色(`app/yahoo/layout.tsx:10` と同じ構成) |
| `/invite` | 未ログイン可 | 招待トークンを読み登録 |
| `/settings/passkeys`(または各 manage 画面内) | ログイン中の本人 | 自分のパスキー一覧・追加(再認証付き)・全端末ログアウト・ログアウト、LINE 連携(yuki) |
| `/api/auth/register/*`, `/api/auth/login/*` | 未ログイン可 | §3 |
| `/api/auth/passkeys/*`, `/api/auth/logout`, `/api/auth/line-link` | ログイン中の本人 | §3.3 / §3.8 / §5.4 |

管理画面(`/admin/*`、`/api/admin/*`)は作らない。招待発行・パスキー失効・他人の全端末ログアウトは GAS エディタ関数で行う(§5.6)。
利用者が増えて GAS エディタ運用がつらくなったら、その時点で管理画面を別タスクとして検討する。

既存コンポーネントの source 依存箇所(`yuki` 対応で直すもの):

- `components/BottomNav.tsx:14` は `isYahoo` の二値判定。パスの先頭セグメントから source レジストリを引く形に変える
  (`?source=` クエリによる判定は廃止または検証付きに)。
- `components/Dashboard.tsx:170` の見出し、`components/ManageView.tsx:36,113` の `isYahoo` による見出しを、レジストリの表示名に置換。
- `isDarkMode` は source と独立の prop(IMPROVEMENTS 3-3)なので、Yuki のテーマはページで指定する。

### 4.2 ログイン後の振り分け・`returnTo`

- ログイン成功時の遷移先: `returnTo` が「同一オリジンの相対パス(`/` 始まりで `//` ・`\` を含まない)かつ
  パスの source ∈ セッションの sources」なら採用、そうでなければ `homeSource` のホーム。
  現状の `router.push(returnTo || '/')`(`app/login/page.tsx:26`)は `//外部` を許す(IMPROVEMENTS 7-1)ので同時に直す。
- `/` へのアクセス: main を持たない利用者(Yuki)は `/yuki` へリダイレクト。

### 4.3 権限のない URL へのアクセス

| 状況 | 挙動 |
| --- | --- |
| 未ログインで保護パス | 現行どおり `/login?returnTo=...`(`middleware.ts:21-23`) |
| ログイン済みだが source 権限なし(画面) | 自分の `homeSource` のホームへ 307 リダイレクト。データ取得は発生しない |
| 同(API `/api/expenses`) | 403 `{ error: 'Forbidden' }`(GAS を呼ばない) |
| GAS が `SessionRevoked` | プロキシは 401 を返し Cookie を削除。クライアントは `/login` へ |

- 「存在を隠す」ために 404 にする案もあるが、自分の家計簿へ戻す方が分かりやすいためリダイレクトを採用。
- middleware の保護対象(`middleware.ts:8`)は列挙ではなく「公開パス以外は全部保護」に変える
  (新しいルートの追加漏れを防ぐ)。公開: `/login`, `/invite`, `/api/auth/register/*`, `/api/auth/login/*`, `/api/line/webhook`, manifest・アイコン等の静的ファイル。
  なお現在の matcher(`middleware.ts:40`)の `login` 除外は `login` で始まる任意のパスに一致するため、`/login` 完全一致に直す。

### 4.4 Yuki 用 PWA manifest

- `public/yuki-manifest.json`(`public/yahoo-manifest.json` と同形): `name` / `short_name`、`start_url: "/yuki"`、
  `scope: "/"`、`display: "standalone"`、テーマ色、アイコン(Yuki 用画像。要確認)。
- 未ログインで `/yuki` を開くと `/login?returnTo=/yuki` → ログイン後 `/yuki` に戻る。
- manifest とアイコンは未ログインでも取得できる必要がある(現状 `/yahoo-manifest.json` は保護パスに一致しない。§4.3 の
  「公開パス以外は全部保護」に変える際、manifest・アイコンを公開リストに入れる)。

---

## 5. GAS の変更点

### 5.1 source レジストリ化と `yuki` 追加

- `SOURCES = { main: {data:'Data', config:'Config', fixed:'Fixed', label:'家庭用', lineKey:'LINE_DESTINATION_MAIN'},
  yahoo: {...'Yahoo_*', label:'個人用', lineKey:'LINE_DESTINATION_YAHOO'}, yuki: {...'Yuki_*', label: <要確認>, lineKey:'LINE_DESTINATION_YUKI'} }`
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
  Yuki はそのアカウントを友だち追加する(要確認: 既存アカウントの利用可否、無料メッセージ数)。

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

### 5.5 `updateCategory` の扱い

現状: `updateCategory` は要求 source に関係なく **main と yahoo の両方**の Data を店舗名一致で書き換え、両方の Config に
ルールを追加し、両方のキャッシュを消す(`gas/コード.js:676-720`、SPECIFICATION §2「両sourceで更新」)。

方針: **「カテゴリ共有グループ」∩「利用者の sources」に限定する**。

- グループ定義(GAS 定数): `[['main','yahoo'], ['yuki']]`。将来の利用者は自分の source 単独のグループ。
- 対象 source = 要求 source が属するグループ ∩ `actor` の sources。
  - 管理者が main / yahoo で実行 → 従来どおり main+yahoo(既存挙動を変えない)。
  - Yuki が yuki で実行 → `Yuki_Data` / `Yuki_Config` のみ。main / yahoo には触れない。
  - 管理者が yahoo のみの権限に変わった場合 → yahoo のみ(権限外の source を書き換えない)。
- `actor` が無い移行期間の旧クライアントは従来どおり main+yahoo(yuki は旧クライアントから来ない)。
- キャッシュ無効化は対象 source ごとに `clearCache`。プロキシは従来どおり `expenses` タグを再検証。
- SPECIFICATION の API 契約表を「共有グループ内で利用者が権限を持つ source の同一店舗」に更新する。

### 5.6 認証情報用の新アクション

- 認証系は source を持たないため、`WRITE_ACTIONS`(`gas/コード.js:460-468`)とは別の `AUTH_ACTIONS` とし、
  doPost で source 検証より前に分岐する(すべて POST。秘密値を URL に載せない)。
- 共通: `PROXY_SECRET` 必須(未設定なら常に `Unauthorized`。移行期間の素通しを適用しない)。書き込みは Script Lock 内。
  認証系シートの変更時は認証用 Script Cache を無効化。応答に招待トークン・ハッシュを含めない。

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
| `authCreateLineLinkCode` / `authLinkLine` / `authGetLineLinkCandidate` / `authConfirmLineLink` | LINE 連携(§5.4) | 本人 / webhook | actor, codeHash / code, lineUserId / actor, decision |

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
- GAS は `PROXY_SECRET` 照合 → source 検証 → `actor` 照合(ユーザー行が `active`、epoch 一致、source ∈ sources)の順で判定。
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
| main / yahoo を混在させない(+ yuki) | source レジストリで 1 source = 1 組のシートを明示し、既定値への落ち込み(`getTargetSheets` の else、LINE 宛先の else)を廃止して未知 source は例外。プロキシ・GAS の両方で source と権限を検証。`updateCategory` は共有グループ内に限定し yuki は単独。Next.js の localStorage キャッシュは既に source 別(`hooks/useExpenses.ts:25`)、ログアウト・ユーザー切替時に消去 |
| 明細1件の更新・削除で MessageId を信用しない | 既存の `rowId` + 厳密照合(`findTransactionRowIndex` `gas/コード.js:125-139`)を yuki でもそのまま使う。変更なし |
| 書き込み時のキャッシュ無効化 | yuki の書き込みは `clearCache('yuki')`、`updateCategory` は対象 source ごと。プロキシの `revalidateTag` は現行どおり。認証系は専用 Script Cache を無効化 |
| 集計ルール(`Income` のみ収入、空カテゴリは未分類) | 集計コード(`lib/expense-analysis` 等、GAS 月次レポート)は source 非依存で共用。変更なし |
| 秘密情報をリポジトリに置かない | 新規の秘密: `LINE_CHANNEL_SECRET`(Vercel)、`LINE_DESTINATION_YUKI`(GAS)。いずれも値はリポジトリに置かない。招待トークンはハッシュのみ保存。テストは架空の userId・鍵・ドメインを使う。この設計書にも実値を書かない |
| GAS API 契約変更時の同時更新 | §11 の各ステップで `gas/コード.js`・呼び出し側・テスト・SPECIFICATION を同一コミットで更新 |
| GAS → UI のデプロイ順 | §7。GAS コミットは旧 UI と互換(新規アクション追加と、`actor` 無しでも main/yahoo を許可)。本リリースは GAS と UI を別 push にし、間に `setupAuthSheets()` を実行 |

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

1. **事前(ユーザー作業)**: 本番ドメインを確定(§3.5)。LINE チャネルシークレットを用意(値は Vercel にのみ設定)。
   `PROXY_SECRET` / `GAS_PROXY_SECRET` が両側に設定済みであることを確認(未設定なら IMPROVEMENTS 4-1 の手順で先に設定。
   新しい認証系アクションは未設定だと全拒否になり、パスワードログインもできなくなるため)。
2. **push 1(GAS のみ)**: §11 の G1〜G4 を push → deploy.yml が GAS をデプロイし `?action=version` で確認。
   docs 以外の UI 変更を含めない(deploy.yml は Vercel にも再デプロイするが、UI は旧版のまま。旧 UI + 新 GAS は互換)。
3. GAS エディタで `setupAuthSheets()`(管理者行作成)と `setupSourceSheets('yuki')` を実行(冪等)。
   `listUsers()` で管理者行が1件あることを確認する。
4. Vercel に `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` / `LINE_CHANNEL_SECRET` を設定。
5. **push 2(UI)**: §11 の U1〜U5 を1回で push → GAS は差分なしでスキップ、Vercel デプロイ。
   v1 Cookie は無効になるので、管理者はパスワードで再ログイン(`authGetAdminUser` による admin の v2 セッション)。
6. 管理者が最初のパスキーを登録(パスワード再入力で再認証)→ 2つ目を1つ目で再認証して登録 → ログアウト → パスキーでログインできることを確認。
7. Vercel から `APP_PASSWORD` を削除(パスワードログイン無効)。以後の非常口は §3.9。
8. GAS エディタで `addUser('Yuki', ['yuki'], 'yuki')` → `createInvite('Yuki', 'register')`。実行ログの URL を Yuki に渡す。
   Yuki が Safari で登録 → ホーム画面に追加 → ホーム画面アプリでパスキーログイン → LINE 連携(表示名を確認して確定)。
9. 動作確認(Yuki: 手入力・固定費・統計。管理者: `/yuki` に入れない、API で `source=yuki` が 403)後、
    GAS の Script Property `AUTHZ_ENFORCE=1` を設定(再デプロイ不要)。問題があれば Property 削除で即戻る。
10. 約2週間後、パスワードログイン・v1 互換・`AUTHZ_ENFORCE` 未設定時の互換コードを削除するコミット(§11 U6/G5)。

手順 7 を 8 より前に置く理由: パスワードログインは admin セッションを発行するため、Yuki にパスワードが伝わると admin になれる。

### 7.3 ロールバック

- UI: `npx vercel rollback`(SPECIFICATION §8)。旧 UI は v2 Cookie を拒否するため、全員パスワードでの再ログインが必要。
  **手順 7(パスワード削除)の前ならロールバック可能**。後なら `APP_PASSWORD` を一時的に再設定してからロールバックする。
  ロールバック中、Yuki はアプリを使えない(旧 UI は yuki を拒否)。Yuki のデータはシートに残る。
- GAS: `clasp deploy -V <前バージョン>`。旧 GAS は `yuki` を `Invalid source` で拒否し、認証系アクションを `Unknown action` で返すため、
  新 UI ではパスキーログインも不可になる。GAS だけ戻す場合は UI も同時に戻す。
- `AUTHZ_ENFORCE` は Property の削除で即時に戻せる。

---

## 8. テスト計画

この環境では E2E を実行できない。`node --test` の単体・GAS VM テストで網羅し、E2E はユーザー環境での手順のみ用意する。
実データは使わず、架空の userId・ドメイン・鍵・明細を使う。

### 8.1 単体(Next.js 側、`test/*.test.mjs`)

- セッション v2(`lib/session.ts`): 発行・検証の往復、sources / epoch の復元、改ざん(各フィールド)、期限切れ、
  未来の発行時刻、長さ上限、v1 トークンの拒否、チャレンジ Cookie をセッションとして受理しないこと(鍵・書式の分離)。
- WebAuthn: ソフトウェア認証器(Node の `crypto` で ES256 鍵を生成し clientDataJSON / authenticatorData を組み立てる)で
  登録・認証の検証成功、origin / rpID / challenge 不一致、UV フラグなし、失効済みパスキー、別ユーザーの userHandle の拒否。
- 招待: トークンのハッシュのみ GAS へ送ること、フラグメントの扱い、期限切れ・使用済み時のエラー表示。
- パスキー追加: 再認証なし・再認証のチャレンジを登録に流用・別ユーザーのパスキーでの再認証をすべて拒否。パスキーを持つ利用者のパスワード再入力による代替を拒否。
- パスワードログイン: `authGetAdminUser` が管理者行を返したときだけ v2 発行。0件・複数・GAS 失敗・`Unauthorized` ではセッションを発行しない。
- `returnTo` 検証: `//evil`、`/\evil`、絶対 URL、権限外 source のパス → ホームへ。
- パス→source 対応(`lib/sources.ts`)と BottomNav のリンク生成(`/yuki` で yuki のタブ)。

### 8.2 プロキシ(`test/expenses-proxy.test.mjs` 拡張)

- `isAllowedSource` が `yuki` を受理、`Yuki` 等の表記ゆれを拒否。
- 権限外 source の GET / POST が 403 で GAS を呼ばないこと(fetch をモック)。
- クライアント送信の `actorUserId` / `actorEpoch` / `key` が除去され、セッション由来の値で上書きされること。
- `actor*` が `unstable_cache` のキー(`toGasQuery` の結果)に含まれないこと、ログ・応答に秘密が出ないこと。
- GAS の `SessionRevoked` で 401 + Cookie 削除。

### 8.3 権限の境界テスト(middleware の判定関数を純粋関数として切り出して表駆動)

| 利用者 | `/` | `/yahoo/*` | `/yuki/*` | `/admin/users`(存在しない) | `GET /api/expenses?source=yuki` | `POST updateCategory source=main` |
| --- | --- | --- | --- | --- | --- | --- |
| 管理者 | 許可 | 許可 | → `/` | 404 | 403 | 許可(main+yahoo) |
| Yuki | → `/yuki` | → `/yuki` | 許可 | 404 | 許可 | 403 |
| 未ログイン | → `/login` | → `/login` | → `/login` | → `/login` | 401 | 401 |

加えて、公開パス(`/login`, `/invite`, `/api/auth/register/*`, `/api/auth/login/*`, `/api/line/webhook`, manifest・アイコン)が保護されないこと、
`/api/auth/passkeys/*`・`/api/auth/logout`・`/api/auth/line-link` が保護されること、`/loginX` のような類似パスが保護されること。

### 8.4 GAS VM テスト(`test/gas-*.test.mjs`、既存のサンドボックス方式)

- `normalizeSource('yuki')`、`getTargetSheets` が未知 source で例外、yuki のシート名。
- yuki の追加・更新・削除が `Yuki_Data` のみを変更し、`clearCache('yuki')` だけが走る(main / yahoo の世代トークン不変)。
- `actor` 照合: actor 無しで yuki → 拒否、epoch 不一致 → `SessionRevoked`、sources 外 → `Forbidden`、`disabled` → 拒否、
  `AUTHZ_ENFORCE=1` で actor 無しの main → 拒否、未設定で actor 無しの main → 許可。
- `updateCategory`: 管理者 actor → main+yahoo(既存テストと同じ結果)、Yuki actor → yuki のみ、actor 無し → main+yahoo、
  いずれも他グループのシート・Config に書き込まないこと。
- 認証系: `PROXY_SECRET` 未設定で全拒否(`authGetAdminUser` を含む)、招待の1回限り(連続2回の消費で2回目失敗)、期限切れ、既存未使用招待の無効化、
  パスキー失効で epoch +1、他人を対象にした操作が Web アクションに存在しないこと、数式インジェクション文字の拒否、
  エディタ関数 `createInvite` が生トークンをシートに保存しないこと。
- 固定費: yuki の固定費 ID に `_yuki` が付く、ある source のロック失敗でも他 source が処理される。
- 月次レポート: `LINE_DESTINATION_YUKI` 未設定でもスキップして他 source は送信、宛先キーの対応、main の例外で yahoo が止まらない。
- LINE 連携: コードの1回限り・期限・source 固定、ハッシュ不一致の拒否、失敗3回で有効コード失効、userId ごと・全体のレート制限、確定前は宛先 Property が変わらないこと、取り消しで候補破棄。
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

## 9. フェーズ2 概要: NAS ワーカーによるメール取込

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
- **個人用(yahoo)を NAS 化する目的は未決**: Olive・JCB の通知は管理者自身の Gmail に届き、現行の GmailApp 取込で既に取り込めている。
  管理者自身のメールである以上、**yahoo は現行の GmailApp 取込のままでよい可能性がある**。NAS 化に意味があるのは、
  別アカウントに届く通知がある場合(画面名「Yahoo Card」`app/yahoo/layout.tsx:9` に対応する PayPay(旧 Yahoo)カードのパーサは現状無い)などに限られる。
  目的をユーザーに確認する(§10.2)。

### 9.2 構成

```text
NAS(TrueNAS Custom App: 1コンテナ)
  ingest-worker ──IMAP(993/TLS, アプリパスワード)──> Gmail
       │
       └──HTTPS POST {action:'ingestEmail'}──> GAS Web App ──> Yuki_Data / Yahoo_Data
```

- 実行方式: TrueNAS Custom App(docker compose)。Node.js 24 + IMAP ライブラリ(例 `imapflow`、採用時にバージョンと最終リリース日を確認)。
  `restart: unless-stopped`。**受信ポートを開けない**(外向きの IMAP と HTTPS のみ)。NAS の変更は `NAS/AGENTS.md` の手順に従う。
- 画面の通り道には入らない: NAS 停止時は取込が遅れるだけで、閲覧・手入力は Vercel → GAS で継続。
- ポーリング: 5 分間隔(IMAP IDLE は任意)。各回 `SINCE <今日-7日>` と送信元条件で検索し、処理済み UID を状態ファイルに記録
  (UIDVALIDITY が変わったら全件再走査、重複は GAS 側で除外されるので安全)。
- **対象メールボックス: ユーザー案と本設計の推奨は異なる。判断はユーザーに委ねる。**

  | | ユーザー案: Yuki 本人の Gmail を NAS が IMAP(アプリパスワード)で直接読む | 本設計の推奨: 取込専用 Gmail へ通知だけ転送 |
  | --- | --- | --- |
  | 方法 | Yuki が自分のアカウントでアプリパスワードを発行し、管理者の NAS に置く | 取込専用の Gmail アカウントを作り、Yuki が自分の Gmail にカード会社の送信元だけを自動転送するフィルタを設定。NAS は取込専用アカウントだけを読む |
  | NAS が持つ権限 | **範囲を絞れない**。アプリパスワードは Yuki のアカウント全体(全メールの読み書き・削除、SMTP での送信)に使える | 取込専用アカウントのみ(届くのはカード通知だけ) |
  | 目的との整合 | 「管理者は Yuki のデータを見られない」と**大きく矛盾**する(管理者の NAS に Yuki の受信箱全体の鍵が置かれる) | 管理者が触れられるのはカード通知(=家計簿に入る情報)に限られる |
  | Yuki の手間 | アプリパスワード発行のみ | 転送先アドレスの確認とフィルタ設定(初回のみ) |
  | 注意点 | 2段階認証必須、アカウント種別によっては発行不可(要確認) | 転送により `X-GM-MSGID` が変わる、DKIM の扱い(下記) |

  ユーザー案を選ぶ場合の緩和策:
  - Yuki 本人に「アプリパスワードは受信箱全体と送信の権限であり、管理者の NAS に保管される」ことを説明し、**明示の同意**を得る。
  - Yuki 専用のアプリパスワードを個別に発行してもらい(他用途と共用しない)、**Yuki が Google アカウント設定からいつでも失効できる**ことを伝える。
    失効されたら取込は停止し、NAS は再試行せず通知だけ出す(§9.3 障害時の挙動)。
  - ワーカーは IMAP の **`EXAMINE`(読み取り専用でメールボックスを開く)**のみを使い、`SELECT`・フラグ変更・移動・削除・SMTP を一切実装しない。
  - 検索は `FROM <カード会社の送信元>` と期間で絞り、一致したメールの本文だけを取得する(他のメールのヘッダ・本文を取得しない)。
    本文はメモリ上で GAS に渡すだけで、NAS のディスク・ログに保存しない。
  - **要確認**: Yuki のアカウントでアプリパスワードが使えるか(2段階認証プロセスの有効化が必須。Google Workspace / 学校・職場アカウント、
    高度な保護機能プログラム利用時は発行できない場合がある)。
  - 転送方式の補足: 転送されたメールではカード会社の DKIM 署名が保持されない・検証できない場合があるため、送信元の真正性は
    転送元 Gmail が付けた判定ヘッダ(`Authentication-Results`)と、転送元アドレスの許可リストで判断する(要確認)。
- 秘密情報の保管: IMAP アプリパスワード・取込用シークレットは NAS のアプリ用データセット上の env ファイル(所有者のみ読取)または
  TrueNAS のアプリ設定の環境変数に置く。リポジトリ・ログ・GAS には置かない。メールボックスごとに別のアプリパスワード。
- 認証: `PROXY_SECRET` を流用せず、**`ingestEmail` 専用の `INGEST_SECRET`**(GAS Script Property)を推奨
  (NAS が漏れても明細の閲覧・削除はできない最小権限)。ユーザー要望の「PROXY_SECRET 認証」との差分として §10 で確認する。

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

1. `INGEST_SECRET` 照合、`source` が取込許可リスト(Script Property またはコード定数。例 `yahoo`, `yuki`)に含まれるか。
2. `from` / `subject` を、既存の検索条件と同じ規則で **source ごとに許可されたパーサ**に照合(楽天 → `parseEmailBody`、
   Vpass → `parseOliveBody`、JCB → `parseJcbBody`)。どれにも一致しなければ `{ "error": "NoParser" }`。
3. パース結果を `determineCategory`(source の Config)で分類し、既存の `appendImportedRows` で追加(ロック・重複除外・RowId・`clearCache`)。
4. 応答: `{ "success": true, "parsed": n, "added": m, "duplicates": k }` / `{ "error": "Busy" }` / `{ "error": "NoParser" }` / `{ "error": "Unauthorized" }`。

冪等性:

- E 列 MessageId に `message.id` を入れ、同じ id の再送は `added: 0`。
- id は **RFC 822 `Message-ID` ヘッダの SHA-256(先頭に `imap:`)に統一**する。Gmail 固有の `X-GM-MSGID` はメールボックスごとに異なり、
  転送方式では転送先で別の値になるため使わない(`Message-ID` は転送でも通常保持される。要確認: カード会社の通知での実際の挙動)。
- この id は既存の GmailApp 取込が書く Gmail メッセージ ID(`message.getId()`)と体系が異なり、同じメールでも重複として検出できない。
  そのため **NAS 取込への切替時点で、同じ source・同じカード会社の GmailApp 取込を同じ GAS コミットで停止する(併用期間は設けない)**。
  切替直前 5 日分は GmailApp 側で取込済みなので、NAS 側の初回は `SINCE` を切替時刻に合わせるか、初回のみ `Ingest_Log` に既存分を記録してから開始する。
- 削除した明細の復活(IMPROVEMENTS 4-3)を防ぐため、処理済み id を明細とは別の `Ingest_Log` シートに記録し重複判定に使う
  (フェーズ2で 4-3 と同時に対応)。

障害時の挙動:

| 事象 | 挙動 |
| --- | --- |
| GAS が `Busy` / 5xx / タイムアウト | 状態(処理済み UID)を進めず、指数バックオフで再試行。重複は GAS が除外 |
| `NoParser` | 処理済みとして記録しスキップ(件名・送信元のみログ。本文はログに出さない) |
| `Unauthorized` | 取込を停止し、エラー状態を記録(シークレット不一致は再試行しても直らない) |
| IMAP 認証失敗(アプリパスワード失効) | 停止して通知 |
| NAS 停止 | 再開時に `SINCE 7日` の範囲で追いつく。7日を超える停止は手入力または範囲拡大で補完 |
| 監視 | GAS が source ごとの最終取込時刻を記録し、24 時間以上更新が無ければ管理者の LINE に通知(件数・明細内容は含めない) |

移行: yahoo の取込を NAS に移す場合(目的が確認できた場合のみ)は、対応する GmailApp 取込(`extractOliveEmails` / `extractJcbEmails`)を
同じ GAS コミットで停止する(併用期間なし。上記の id 体系の理由)。Yuki のカード会社が既存3社以外なら新パーサを追加する(カード会社確定後)。

---

## 10. リスクと未決事項

### 10.1 リスク

| リスク | 影響 | 対策 |
| --- | --- | --- |
| RP ID がドメインに固定 | ドメイン変更・NAS 移行で全パスキーが無効 | フェーズ1前にドメイン確定。変更時は再招待 / Related Origins |
| `getTargetSheets` 等の既定値分岐 | yuki が家庭用シートに書かれる | レジストリ化・未知 source は例外・テスト(§5.1) |
| 管理者のパスキー全損 | ログイン不能 | 2つ以上登録、GAS エディタの非常口(§3.9) |
| ログインの GAS 往復(コールド 1〜3 秒) | ログインが遅い | 30 日セッション。options は GAS 不要 |
| 一覧キャッシュ中は epoch 失効が読み取りに最大5分反映されない | 失効直後の閲覧 | 許容(書き込みは即時)。必要なら失効時に `revalidateTag('expenses')` |
| iOS PWA と Safari のストレージ分離 | 登録後に再ログインが必要 | 案内文言 |
| LINE 内ブラウザで招待を開く | 登録失敗 | Safari で開く案内 |
| `PROXY_SECRET` 未設定の素通し | yuki・認証系が無防備 | yuki・認証系は未設定時に拒否、4-1 残課題を先に解消 |
| 管理者による技術的閲覧・なりすまし | Yuki のプライバシー | 仕様として明記、パスキー追加時に Yuki へ LINE 通知 |
| フェーズ2のアプリパスワード(ユーザー案) | Yuki の受信箱全体と送信の権限が管理者の NAS に置かれ、「管理者は Yuki のデータを見られない」と矛盾 | 推奨は取込専用アカウント + 転送フィルタ。ユーザー案なら Yuki の同意・EXAMINE のみ・送信元で絞った検索・個別発行と失効手段の説明(§9.2) |

### 10.2 ユーザーへの確認事項

1. 現在の共有パスワードを管理者以外(家族など)も使っていますか? 使っている場合、その人にも利用者アカウント(sources=main 等)が必要です。
2. 本番ドメインはこのまま Vercel の既定ドメインで確定してよいですか? 独自ドメインや NAS への移行予定があるなら、パスキー登録前に決める必要があります。
3. 家計簿のスプレッドシートを誰かと共有していますか? 共有しているなら、Yuki のシートと認証用シートは別スプレッドシートに分けます。
4. 管理者は Yuki の家計簿をアプリでは見られないが、スプレッドシートの所有者として技術的には見られる、という仕様で Yuki の了承は取れていますか?
5. Yuki に渡す招待リンクの有効期限は 24 時間でよいですか?
6. Yuki の LINE 月次レポートは、既存の LINE 公式アカウントを Yuki が友だち追加する形でよいですか?(webhook の URL を Vercel に変更し、LINE のチャネルシークレットを Vercel に設定する必要があります)
7. Yuki のカテゴリは今の共通カテゴリ(音ゲー・ダーツ等を含む)でよいですか? Yuki 専用にするなら別タスクになります。
8. Yuki の画面の名前・配色・ホーム画面アイコンの希望はありますか?
9. パスワードログインの廃止は「管理者のパスキー登録確認後すぐ(Yuki 招待より前)」でよいですか?
10. 各利用者にパスキーを2つ以上(例: iPhone と Mac / iPad)登録できますか? Yuki の iPhone で iCloud キーチェーンは有効ですか?
11. Yuki の iPhone の iOS バージョンはいくつですか?(ホーム画面アプリでのパスキー利用に iOS 16 以上が必要)
12. 名前「yuki」を source ID・URL(`/yuki`)・シート名(`Yuki_*`)・Script Property 名に使ってよいですか?
    URL やシート名に個人名を出したくない場合は、中立な ID(例 `member1` / `/m1` / `Member1_*`)にし、表示名だけ「Yuki」にします。
13. Yuki が利用をやめた場合、データ(`Yuki_*` シート)はどうしますか?(Yuki にエクスポートして渡す / 一定期間後に削除 / 残す。いずれもユーザー無効化と epoch 更新は即時に行います)
14. 【フェーズ2】Yuki のカード会社はどこですか?(既存パーサは楽天・三井住友 Olive・JCB)
15. 【フェーズ2】個人用(yahoo)のメールを NAS 経由にしたい理由は何ですか? yahoo の通知は管理者自身の Gmail に届いて現行の GmailApp 取込で取り込めているため、目的がなければ yahoo は現行のままにします。
16. 【フェーズ2】Yuki のメールは、(a) ユーザー案: Yuki 本人の Gmail を NAS が IMAP(アプリパスワード)で読む、(b) 本設計の推奨: 取込専用 Gmail へカード通知だけ転送、のどちらにしますか?(差分は §9.2)
17. 【フェーズ2】(a) を選ぶ場合、アプリパスワードが Yuki のアカウント全体(受信箱全体の読み書き・送信)の権限で、管理者の NAS に保管されることについて Yuki 本人の同意を得られますか? また Yuki のアカウントでアプリパスワードを発行できますか(2段階認証が有効か、個人の Google アカウントか)?
18. 【フェーズ2】NAS ワーカーの認証は、`PROXY_SECRET` の流用ではなく取込専用のシークレットにしてよいですか?

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
| G2 | `actor` 照合(Script Cache 上のユーザー表、epoch、`AUTHZ_ENFORCE`、yuki は actor 必須)、`updateCategory` の共有グループ化。VM テスト。SPECIFICATION の API 契約・認証節 | M |
| G3 | 認証系(`Auth_*` シート、`authGetAdminUser`、招待の原子的消費、パスキー取得・記録・追加・失効、チャレンジ再利用記録、epoch)と GAS エディタ関数(`setupAuthSheets` / `addUser` / `disableUser` / `createInvite` / `revokeCredential` / `bumpEpoch` / `listUsers`)。`PROXY_SECRET` 未設定時の拒否。VM テスト | L |
| G4 | LINE 連携(`authCreateLineLinkCode` / `authLinkLine` / `authGetLineLinkCandidate` / `authConfirmLineLink`、失敗3回失効、userId ごと・全体のレート制限、プロフィール API、`LINE_DESTINATION_YUKI` の設定)。VM テスト | M |

### push 2: UI コミット(push 1 のデプロイ確認と `setupAuthSheets()` 実行の後)

| # | 内容 | 規模 |
| --- | --- | --- |
| U1 | `lib/sources.ts`、`isAllowedSource` の yuki 対応、`/yuki` 配下ページ・layout・`yuki-manifest.json`、BottomNav / Dashboard / ManageView のレジストリ化、`ExpenseDetailModal` / `fetchExpenses` / `useExpenses` の source 必須化。レジストリ一致テスト。(この時点では旧 v1 セッションのまま。yuki は GAS が actor 無しを拒否するので読めない) | M |
| U2 | セッション v2(`readSession`)、**パスワードログインを `authGetAdminUser` による admin の v2 発行に変更**(定数時間比較、`APP_PASSWORD` 未設定で無効化)、middleware の「公開パス以外は保護」+ source 判定(純粋関数化して表駆動テスト)、プロキシの 403・`actor` 付与・`SessionRevoked` 処理、ログアウトと localStorage 消去、`returnTo` 検証 | L |
| U3 | パスキー登録・ログイン・追加(再認証必須、ブートストラップはパスワード再入力)の API と画面(`@simplewebauthn/*` 固定版追加、`/invite`、`/login` 改修、`/settings/passkeys`)、チャレンジ Cookie。ソフトウェア認証器テスト | L |
| U4 | 本人のパスキー一覧・失効・全端末ログアウト、パスキー追加時の LINE 通知呼び出し | S |
| U5 | LINE webhook(`/api/line/webhook`、生本文での署名検証、連携コード転送)と Yuki の「LINE 連携」画面(コード発行・表示名の確認と確定) | M |

### 後続(安定後、目安2週間)

| # | 内容 | 規模 |
| --- | --- | --- |
| U6 | パスワードログイン・v1 互換の削除、E2E を仮想認証器版へ置換 | S |
| G5 | `AUTHZ_ENFORCE` 未設定時の互換と `PROXY_SECRET` 未設定時の素通しを削除(IMPROVEMENTS 4-1 完了)。U6 と別 push で GAS 先行 | S |

ドキュメント: 各ステップで SPECIFICATION・CODEMAP を更新し、完了時に IMPROVEMENTS に記録する。
本設計書は実装完了後に「実装済み」と状態を更新し、正本は SPECIFICATION とする。
