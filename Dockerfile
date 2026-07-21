# Node.jsの公式イメージを使用
FROM node:18-alpine

# コンテナ内の作業ディレクトリを作成
WORKDIR /app

# package.jsonとpackage-lock.jsonをコピー
COPY package*.json ./

# 依存関係をインストール
RUN npm install

# 残りのソースコードをすべてコピー
COPY . .

# アプリが使用するポートを開放（server.jsに合わせて3000などにします）
EXPOSE 3000

# コンテナ起動時に実行するコマンド
CMD ["node", "server.js"]