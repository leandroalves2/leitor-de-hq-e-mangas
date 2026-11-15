#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
HOST=127.0.0.1
[ "$1" = "rede" ] && HOST=0.0.0.0
echo "ComicStream rodando em http://localhost:8080"
exec php -d upload_max_filesize=2G -d post_max_size=2G -d max_file_uploads=50 -d memory_limit=512M -d max_execution_time=0 -d display_errors=0 -S "$HOST:8080" -t public
