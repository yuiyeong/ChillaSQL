#!/usr/bin/env bash
# test DB(PostgreSQL 18, docker compose)를 띄우고 seed를 검증한다.
# 사용법: scripts/test-db.sh [up|reset|down]   (인자가 없으면 up)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

URL="postgres://chilla:chilla@127.0.0.1:54318/chilla_test"
EXPECTED="1000000|100000|100000"
QUERY="SELECT count(*), count(*) FILTER (WHERE note IS NULL), count(*) FILTER (WHERE note = '') FROM big_table;"

up() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker가 실행 중이 아닙니다"
    exit 1
  fi
  docker compose up -d --wait
  local actual
  actual="$(docker compose exec -T db psql -U chilla -d chilla_test -tAc "$QUERY")"
  if [ "$actual" != "$EXPECTED" ]; then
    echo "데이터가 기대와 다릅니다. scripts/test-db.sh reset 을 실행하세요"
    exit 1
  fi
  echo "test DB 준비 완료: $URL"
}

case "${1:-up}" in
  up) up ;;
  reset)
    docker compose down -v
    up
    ;;
  down) docker compose down ;;
  *)
    echo "사용법: scripts/test-db.sh [up|reset|down]" >&2
    exit 2
    ;;
esac
