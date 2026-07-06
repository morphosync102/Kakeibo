# 改善バックログ

2026-07-06 のコード調査で洗い出した改善点。優先度順。
着手時は [SPECIFICATION.md](SPECIFICATION.md) と [../AGENTS.md](../AGENTS.md) の不変条件、
GAS 変更を伴う場合は [.agents/skills/kakeibo-gas/SKILL.md](../.agents/skills/kakeibo-gas/SKILL.md) の手順に従うこと。

凡例 — **GASデプロイ**: Apps Script への貼り付け + 新バージョンデプロイが必要か。

## P1 — 明細編集操作の統一(ユーザー報告: 画面によって編集・削除ができない)

現状の対応表は [CODEMAP.md](CODEMAP.md) を参照。ゴールは
「**明細が見えるすべての画面で、タップ → 同じ詳細モーダル → 日付・カテゴリ・金額の変更と削除ができる**」こと。

### 1-1. GAS に `updateTransaction` action を新設(金額変更を可能にする)

- 症状: 金額(および店舗名)を変更する手段がどの画面にもない。
- 原因: GAS 側に単一明細の汎用更新 action が存在しない(`gas/コード.js` の doPost 分岐参照)。
- 方針: `updateTransactionDate` と同じ厳密照合方式(MessageId + 変更前日付 + 店舗名 + 変更前金額)で
  1件を特定し、金額・(任意で)店舗名・カテゴリを更新する action を追加。
  成功後 `clearCache(source)`。呼び出し側・`test/gas-*.test.mjs`・SPECIFICATION の API 契約表を同時更新。
- GASデプロイ: **必要**(GAS 先行 → Vercel の順)。

### 1-2. ExpenseDetailModal に金額編集 UI を追加

- 対象: `components/ExpenseDetailModal.tsx`(日付エディタと同じ構成で金額欄 + 保存ボタン)。
- 依存: 1-1 が本番デプロイ済みであること。

### 1-3. カレンダーの日別明細から詳細モーダルを開く ✅ 対応済み (2026-07-07)

- 症状: カレンダー(`components/CalendarView.tsx` の日別明細)は削除しかできない。
- 方針: 明細タップで `ExpenseDetailModal` を開く(Dashboard と同じ `selectedExpense` パターンを再利用)。
  インラインの削除ボタンはモーダル内の削除に置き換え。
- GASデプロイ: 不要(1-2 と同時なら 1-1 に依存)。

### 1-4. 「この1件だけ」のカテゴリ変更オプション

- 症状: カテゴリ変更は常に「同一店舗の全明細(両source)+ Config の自動分類ルール」一括で、
  1件だけ変えたいケース(同じ店で用途が違う買い物など)に対応できない。
- 方針: モーダルで「この明細のみ / この店舗すべて」を選択式にする。
  「この明細のみ」は 1-1 の `updateTransaction`(category のみ更新)を利用。
- GASデプロイ: 1-1 に含まれる。

### 1-5. `deleteTransaction` を厳密照合へ移行(既知制約の解消)

- 症状: MessageId の先頭一致で1件削除するため、同一メール由来の複数明細がある場合に
  意図しない行を消す可能性がある(AGENTS.md / SPECIFICATION.md 記載の既知制約)。
- 方針: `updateTransactionDate` と同じ照合(id + date + merchant + amount)へ移行。
  呼び出し側(`ExpenseDetailModal.tsx`、`CalendarView.tsx`)と GAS を**同時に**変更する。
- GASデプロイ: **必要**。

## P1 — 体感速度(ユーザー報告: レスポンスが遅い)

根本原因は GAS Web App のレイテンシ(コールド時 1〜3 秒)+ 書き込み後キャッシュ無効化による
コールドリード。GAS を残す前提では「GAS を待たせない UI」にするのが効果的。

### 2-1. 固定費一覧のキャッシュバスター除去 ✅ 対応済み (2026-07-07)

- 症状: 管理画面の固定費タブを開くたびに数秒待つ。
- 原因: `components/ManageView.tsx` の `fetchFixedCosts` が `t=${Date.now()}` を付けるため
  Next.js の fetch キャッシュ(URLキー)が毎回ミスし、常に GAS 直行になる。
- 方針: `t` パラメータを除去し、`app/api/expenses/route.ts` で固定費 GET に `fixedCosts` タグを付与。
  `addFixedCost` / `deleteFixedCost` の POST 成功後に `revalidateTag('fixedCosts')`。
- GASデプロイ: 不要。**最も低リスクで効果が分かりやすい**。

### 2-2. 書き込み操作の楽観的更新 ✅ 対応済み (2026-07-07)

- 症状: 削除・日付変更・追加のたびに全明細を GAS から再取得し、完了まで待たされる。
- 原因: 各ハンドラが成功後に `refresh()`(全件再取得)を呼ぶだけで、ローカル state を即時更新しない。
- 方針: `hooks/useExpenses.ts` に楽観的更新用のミューテーション関数
  (例: `removeLocal(expense)` / `updateLocal(expense)`)を追加し、
  UI は即時反映 → バックグラウンドで再取得・失敗時ロールバック。
- GASデプロイ: 不要。

### 2-3. `alert()` / `confirm()` を非ブロッキング UI へ置換 ✅ 対応済み (2026-07-07, sonner)

- 症状: 操作のたびにブラウザダイアログで全体がブロックされ、遅く感じる。
- 対象: `ExpenseDetailModal.tsx`、`CalendarView.tsx`、`ManageView.tsx`。
- 方針: トースト(成功/失敗)+ 破壊的操作は Undo 付きトーストまたはモーダル内確認に置換。
- GASデプロイ: 不要。

### 2-4. POST レスポンスで更新後データを返す(検討)

- 方針: GAS の書き込み action が更新後の明細一覧(または差分)を返せば、
  書き込み後の再取得(コールドリード)を丸ごと省略できる。2-2 で体感が十分なら不要。
- GASデプロイ: **必要**。

## P2 — コード品質

### 3-1. カテゴリ定数の集約 ✅ 対応済み (2026-07-07)

- 症状: 支出カテゴリのリストが `Dashboard.tsx` / `ExpenseDetailModal.tsx` / `ManageView.tsx` に
  三重複(収入カテゴリは ManageView のみ)。カテゴリ追加時に同期漏れしやすい。
- 方針: `lib/categories.ts` に集約して各コンポーネントから import。

### 3-2. `fetchExpenses` のエラー握りつぶし ✅ 対応済み (2026-07-07)

- 症状: `lib/api.ts` がエラー時に `[]` を返すため、通信失敗が「データ0件」と区別できない。
  `useExpenses` のバックグラウンド更新経由で localStorage キャッシュが空配列で上書きされる恐れもある。
- 方針: エラーは throw し、`useExpenses` 側で「キャッシュ維持 + エラー表示」に分岐。

### 3-3. `isYahoo` とテーマ判定の混線解消 ✅ 対応済み (2026-07-07)

- 症状: `ManageView.tsx` が「ダークモード = yahoo」とみなしており、source 判定とテーマ判定が混線。
- 方針: source とテーマを独立した prop として扱う(他コンポーネントと同じ形に揃える)。

### 3-4. CalendarView の集計メモ化 ✅ 対応済み (2026-07-07)

- 症状: 月間サマリーと 42 日分のセルが毎レンダーで `expenses` 全件を複数回 filter する。
- 方針: 日別集計を `useMemo` で `Map<日付, {income, expense}>` に前計算。データ量が増えるまでは軽微。

## P3 — その他

- テスト拡充: カテゴリ変更・削除フロー(現状のテストは日付編集・初期表示月・GAS レポートのみ)。
- ローディング統一: Dashboard にはスケルトンがあるが CalendarView / ManageView にはない。
- Next.js 16 の新キャッシュ機構(cacheComponents 等)の活用検討。

## 対応済み(参考)

- ダッシュボード初期表示が当月にならない問題(e4d5917)
- 明細の日付編集(4ff187c)
- JCB 通知メールの取込(673aadd)
