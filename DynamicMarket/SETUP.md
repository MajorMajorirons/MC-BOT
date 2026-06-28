# DynamicMarket セットアップ手順

## Phase 1: Mohist への移行

1. Mohist 1.20.1 の JAR をダウンロード: https://mohistmc.com/builds
2. ダウンロードした JAR を server/ フォルダに置き `mohist-1.20.1.jar` にリネーム
3. `start-server.js` の「設定 2」セクションで:
   - Forge の行をコメントアウト
   - Mohist の行を有効化
4. 初回起動時に Mohist が Forge MOD と Bukkit プラグインの両方を自動セットアップ

## Phase 2: Vault + EssentialsX インストール

ダウンロード先:
- **Vault**: https://www.spigotmc.org/resources/vault.34315/
- **EssentialsX**: https://essentialsx.net/downloads.html

1. `server/plugins/` フォルダに Vault.jar と EssentialsX.jar を置く
2. サーバーを起動すると自動で設定ファイルが生成される
3. `plugins/Essentials/config.yml` で通貨単位などを設定

## Phase 3: DynamicMarket プラグインをビルド

前提条件: [Maven](https://maven.apache.org/download.cgi) をインストールして PATH に追加

```
DynamicMarket\build.bat
```

`plugins/DynamicMarket.jar` が生成される。

## Phase 3: アイテムの初期価格設定

ゲーム内でOPとして以下のコマンドを使用:

```
/mktadmin additem minecraft:diamond ダイヤモンド 1000
/mktadmin additem minecraft:iron_ingot 鉄インゴット 50
/mktadmin additem minecraft:gold_ingot 金インゴット 150
```

MOD アイテムの場合、名前空間:アイテムID 形式で登録:
```
/mktadmin additem thermal:copper_ingot 銅インゴット 30
```

## Phase 4: Discord /market コマンドを有効化

```
npm install better-sqlite3
```

これで `/market price` と `/market list` がサーバーオフライン時も動作するようになる。

## 価格エンジンのチューニング

`plugins/DynamicMarket/config.yml` で調整:

| パラメータ | 意味 | デフォルト |
|---|---|---|
| market-depth | 価格が63%動くまでに必要な取引量 | 1000 |
| volatility | 最大価格変動率 (0.3 = 30%) | 0.3 |
| decay-rate | 1秒ごとの基準値への戻り率 | 0.00005 |
| transaction-fee | 取引手数料 (0.02 = 2%) | 0.02 |

`/mktadmin reload` でサーバー再起動なしに設定を反映できる。
