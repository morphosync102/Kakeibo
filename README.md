# My Kakeibo (Personal Finance Tracker)

<img width="290" alt="Image" src="https://github.com/user-attachments/assets/2848e94d-bcb2-4f81-9a32-524c900123ae" />

Googleスプレッドシートと連携する、個人用の家計簿アプリケーションです。
Next.js (App Router) で構築され、Vercel上にデプロイされています。

現行仕様と設計は [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) を参照してください。
コード全体の見取り図は [`docs/CODEMAP.md`](docs/CODEMAP.md)、
既知の課題と改善バックログは [`docs/IMPROVEMENTS.md`](docs/IMPROVEMENTS.md) にあります。
GASを変更する場合は [`.agents/skills/kakeibo-gas/SKILL.md`](.agents/skills/kakeibo-gas/SKILL.md)
の手順に従ってください。

## 特徴
- **Google Sheets連携**: データは全てスプレッドシートに保存されるため、データの自由度が高いです。
- **自動取込 (GAS)**: Google Apps Script (GAS) を使用して、楽天カードやOliveの利用通知メールから明細を自動でスプレッドシートに記録します（※GAS側の設定が必要です）。
- **レスポンシブデザイン**: スマートフォンでもPCでも快適に操作できます。
- **ダークモード対応**: Vercelの環境変数で設定可能です。
- **簡易認証**: アプリケーションレベルでのパスワード認証機能を搭載。

## Tech Stack
- **Frontend**: Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS
- **Backend / DB**: Google Apps Script (GAS), Google Sheets
- **Deployment**: Vercel


## License
Personal Use Only / MIT
