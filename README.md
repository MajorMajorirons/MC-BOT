# ForgeMinecraftServer 管理システム

Minecraft 1.20.1 (Mohist / Forge+Bukkit ハイブリッド) サーバー用の Node.js 管理システムです。  
Discord Bot・Web 管理パネル・プレイヤーマーケット機能を一体化しています。

---

## 主な機能

### Discord Bot
- サーバーのオンライン/オフライン状態をリアルタイムで Discord チャンネルに通知
- 起動完了後に e4mc 接続 IP を表示（📋 コピーボタン付き）
- プレイヤーの参加・退出をアナウンス
- Minecraft チャットを Discord に転送（Discord 連携済みプレイヤーは Discord アバター・名前で表示）
- サーバークラッシュ時に自動再起動し Discord へ通知
- Bot 起動・MC サーバー起動時に古いステータスメッセージを自動削除
- `/start` `/stop` `/restart` スラッシュコマンド（起動途中の強制停止も対応）

### Web 管理パネル (`http://localhost:4000`)
Discord OAuth2 でログインして使用します。

| タブ | 機能 |
|---|---|
| ステータス | サーバーのオンライン状態・プレイヤー数の確認 |
| コントロール | サーバーの起動・停止・再起動 |
| マーケット | DynamicMarket の出品一覧・Discord 連携状況の確認 |
| モデレーション | 処罰・解除・履歴・自動エスカレーション設定 |
| スケジュール | 定期再起動の設定（cron 式 / 曜日・時刻指定） |

#### モデレーション詳細
- 参加経験のある全プレイヤーをチェックボックス一覧で選択
- **追放 (Kick)**: オンラインのみ実行可
- **参加停止 (Tempban)**: オンライン・オフライン問わず実行可（オンライン時は自動追放→参加停止）。サーバー停止中も `banned-players.json` を直接書き換えて実行
- **BAN**: オンライン・オフライン問わず実行可。サーバー停止中も実行可
- **解除**: 処罰履歴の各行にボタンを設置（BAN解除・参加停止解除）。サーバー停止中も実行可
- **自動エスカレーション**: 追放 N 回で自動参加停止、参加停止 N 回で自動 BAN（閾値・期間を管理パネルで設定）
- 処罰の重さ: 追放 Lv.1 → 参加停止 Lv.2 → BAN Lv.3（低レベル処罰が高レベルを上書きしない）
- 解除すると処罰履歴・カウントが削除される

#### アクセス権限
- **サーバーオーナー（Discord ギルドオーナー）**: 処罰されても常に管理パネルへアクセス可
- **管理者ロール保持者**: アクセス可
- **それ以外**: アクセス不可

### DynamicMarket プラグイン (Java / Bukkit)
- プレイヤー間のアイテム売買マーケット
- 需要・供給に応じた動的価格変動
- Discord アカウントとの連携 (`/mclink`)

---

## 必要環境

| ソフトウェア | バージョン |
|---|---|
| Java | 17 以上 |
| Node.js | 18 以上 |
| Minecraft Server | Mohist 1.20.1 |
| EssentialsX | 参加停止機能に必要 |

---

## セットアップ

### 1. リポジトリをクローン
```bash
git clone <このリポジトリの URL>
cd server
```

### 2. Node.js パッケージをインストール
```bash
npm install
```

### 3. `.env` を作成
`.env.example` をコピーして `.env` を作成し、各項目を設定します。

```bash
cp .env.example .env
```

### 4. Minecraft サーバー本体を用意
[Mohist 1.20.1](https://mohistmc.com/) の JAR をダウンロードし、`server/` フォルダに配置します。  
`start-server.js` 内の `MOHIST_JAR` 変数をダウンロードしたファイル名に合わせてください。

Mod を使用する場合は `mods/` フォルダに JAR を配置してください。

### 5. サーバーを起動
```bash
node start-server.js
```

---

## 環境変数 (`.env`)

| 変数名 | 説明 | 取得場所 |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Discord Bot のトークン | [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Token |
| `DISCORD_CHANNEL_ID` | サーバー状態を投稿するチャンネルの ID | Discord でチャンネルを右クリック → ID をコピー |
| `ADMIN_ROLE_ID` | 管理パネルへのアクセスを許可する Discord ロールの ID | Discord でロールを右クリック → ID をコピー |
| `CLIENT_ID` | Discord アプリケーション ID | Developer Portal → General Information → Application ID |
| `GUILD_ID` | 対象 Discord サーバーの ID | Discord でサーバーを右クリック → ID をコピー |
| `ADMIN_PORT` | Web 管理パネルのポート番号（デフォルト: `4000`） | 任意のポート番号 |
| `ADMIN_PANEL_URL` | 管理パネルの公開 URL（OAuth2 リダイレクト URI に使用） | 例: `http://localhost:4000` または公開サーバーの URL |
| `DISCORD_CLIENT_SECRET` | Discord OAuth2 クライアントシークレット | Developer Portal → OAuth2 → Client Secret |

### Discord Developer Portal での OAuth2 設定
`ADMIN_PANEL_URL/auth/callback` をリダイレクト URI に追加してください。  
例: `http://localhost:4000/auth/callback`

---

## フォルダ構成

```
server/
├── start-server.js        # メインエントリーポイント（Discord Bot + サーバー管理）
├── admin-panel.js         # Web 管理パネル（Express + WebSocket）
├── package.json           # Node.js 依存関係
├── schedule-config.json   # 再起動スケジュール設定
├── .env.example           # 環境変数テンプレート
├── server.properties      # Minecraft サーバー設定
├── user_jvm_args.txt      # JVM 起動引数
├── mods/                  # Forge Mod を配置するフォルダ（中身は各自で用意）
├── DynamicMarket/         # マーケットプラグイン (Java ソース)
└── plugins/               # Bukkit プラグイン設定ファイル
```

---

## ライセンス

このプロジェクトは個人利用・学習目的で公開しています。
