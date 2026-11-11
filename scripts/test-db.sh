#!/usr/bin/env bash
# test DB(PostgreSQL 18, docker compose)를 띄우고 seed를 검증한다.
# db: 54318 (100만 행 seed), db-tls: 54319 (SSL 켬, seed 없음. 인증서는 db/tls 에 만든다)
# 사용법: scripts/test-db.sh [up|reset|down]   (인자가 없으면 up)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

URL="postgres://chilla:chilla@127.0.0.1:54318/chilla_test"
# 기대값은 db/init/01-big-table.sql 의 seed 규모에서 나온다.
EXPECTED="1000000|100000|100000"
QUERY="SELECT count(*), count(*) FILTER (WHERE note IS NULL), count(*) FILTER (WHERE note = '') FROM big_table;"

TLS_DIR="db/tls"

# db-tls 용 인증서. macOS의 LibreSSL에서도 되는 option만 쓴다.
#   ca.crt        test CA
#   server.crt    CA가 서명한 서버 인증서. SAN은 DNS:localhost 뿐이다(IP SAN 없음).
#                 127.0.0.1 로 붙으면 host 이름이 맞지 않아야 verify-full 거부를 test할 수 있다.
#   other-ca.crt  서버 인증서와 무관한 CA
gen_certs() {
  rm -rf "$TLS_DIR"
  mkdir -p "$TLS_DIR"
  (
    cd "$TLS_DIR"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=chilla-test-ca" \
      -keyout ca.key -out ca.crt 2>/dev/null
    openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
      -keyout server.key -out server.csr 2>/dev/null
    printf 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' >server.ext
    openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 \
      -extfile server.ext -out server.crt 2>/dev/null
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=chilla-other-ca" \
      -keyout other-ca.key -out other-ca.crt 2>/dev/null
    rm -f server.csr server.ext ca.srl
  )
}

up() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker가 실행 중이 아닙니다" >&2
    exit 1
  fi
  if [ ! -f "$TLS_DIR/server.crt" ]; then
    gen_certs
  fi
  docker compose up -d --wait
  local actual
  # 검증 query 자체가 실패해도(table 없음 등) 불일치로 취급해 아래 hint를 출력한다.
  actual="$(docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$0"' "$QUERY")" || actual=""
  if [ "$actual" != "$EXPECTED" ]; then
    echo "데이터가 기대와 다릅니다. scripts/test-db.sh reset 을 실행하세요" >&2
    exit 1
  fi
  echo "test DB 준비 완료: $URL"
}

case "${1:-up}" in
  up) up ;;
  reset)
    docker compose down -v
    rm -rf "$TLS_DIR"
    up
    ;;
  down) docker compose down ;;
  *)
    echo "사용법: scripts/test-db.sh [up|reset|down]" >&2
    exit 2
    ;;
esac
