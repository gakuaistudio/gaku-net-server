# 対戦中継サーバーのデプロイ（Render 無料枠）

このフォルダ（`gaku-net-server.js`）を Render にデプロイすると、インターネット経由で
アニマルズ・BOMB24・ゴーストパニック・この僕、**全ゲーム共通**でオンライン対戦できるようになる
（1つのサーバーで `gameId` ごとに部屋を分けているため、ゲームごとに個別デプロイは不要）。

コード変更は不要（`PORT` 環境変数・CORSともに対応済み）。デプロイ用に `package.json` / `render.yaml` /
`.gitignore` をこのフォルダに追加済み。

## 手順

### 1. GitHubにこのフォルダを置く

GitHubアカウントが無ければ https://github.com/join で作成（無料）。

1. https://github.com/new でリポジトリ作成（例: `gaku-net-server`、Public でよい、README等は追加しない）
2. 作成後に表示されるコマンドのうち、**「…or push an existing repository from the command line」**の
   下に出る2行（`git remote add origin ...` と `git push -u origin main`）をコピー
3. このフォルダ（`server/`）でターミナルを開き、その2行を貼り付けて実行
   （初回はブラウザでGitHubへのログインを求められることがある）

### 2. Renderでデプロイ

1. https://render.com で無料登録（GitHubアカウントでログインすると連携が早い）
2. ダッシュボードで **New +** → **Web Service**
3. 「Build and deploy from a Git repository」→ 先ほどの `gaku-net-server` リポジトリを選択
   （GitHub連携の許可を求められたら許可）
4. 設定項目:
   - **Name**: 好きな名前（例 `gaku-net-server`）
   - **Region**: Singapore など日本から近いところ
   - **Branch**: `main`
   - **Root Directory**: 空欄のまま（このリポジトリ＝フォルダ自体がサーバー本体のため）
   - **Runtime**: Node
   - **Build Command**: 空欄でよい（依存パッケージ無し）
   - **Start Command**: `node gaku-net-server.js`
   - **Instance Type**: **Free**
5. **Create Web Service** をクリック → 数十秒でビルド・起動する
6. 完了すると `https://（好きな名前）.onrender.com` のようなURLが発行される。
   ブラウザでそのURLを開き、`{"ok":true,"service":"gaku-net-server",...}` のようなJSONが
   表示されれば成功。**このURLをひかえておく**（アプリ側に設定する）

### 3. アプリ側へ反映

発行されたURLを教えてもらえれば、`shared/gaku-platform/net.js` の既定接続先に設定し、
全ゲームへ同期・再ビルドする。

## 無料枠の注意点

- 15分アクセスが無いとスリープする。次のアクセス時に自動で起き上がるが30〜50秒ほどかかる
  （オンライン対戦を開いた最初の1回だけ、繋がるまで少し待つことがある）
- クレジットカード登録不要。上位プランへは手動でしか切り替わらないので、勝手に課金される心配はない
