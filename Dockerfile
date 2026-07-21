# 軽量なWebサーバー（Nginx）を使用
FROM nginx:alpine

# フロントエンドのファイルをNginxの公開ディレクトリにコピー
COPY ./src /usr/share/nginx/html

# 30番ポートを開放
EXPOSE 30