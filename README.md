# My Kakeibo (Personal Finance Tracker)

Googleスプレッドシートと連携する、個人用の家計簿アプリケーションです。
Next.js (App Router) で構築され、Vercel上にデプロイされています。

## 特徴
- **Google Sheets連携**: データは全てスプレッドシートに保存されるため、データの自由度が高いです。
- **自動取込 (GAS)**: Google Apps Script (GAS) を使用して、楽天カードやOliveの利用通知メールから明細を自動でスプレッドシートに記録します（※GAS側の設定が必要です）。
- **レスポンシブデザイン**: スマートフォンでもPCでも快適に操作できます。
- **ダークモード対応**: Vercelの環境変数で設定可能です。
- **簡易認証**: アプリケーションレベルでのパスワード認証機能を搭載。

## Tech Stack
- **Frontend**: Next.js 14 (App Router), TypeScript, Tailwind CSS
- **Backend / DB**: Google Apps Script (GAS), Google Sheets
- **Deployment**: Vercel


## License
Personal Use Only / MIT
