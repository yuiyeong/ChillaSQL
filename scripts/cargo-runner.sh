#!/bin/sh
# cargo가 `cargo run`과 `cargo test`의 binary를 실행하기 전에 부른다.
# 앱 binary만 고정된 identity로 서명해, 다시 빌드해도 키체인이 같은 앱으로 보게 한다.
bin="$1"
shift
if [ "$(basename "$bin")" = "chillasql" ]; then
  identity="${CHILLA_DEV_IDENTITY:-$(security find-identity -v -p codesigning | awk 'NR == 1 && $2 ~ /^[0-9A-F]+$/ { print $2 }')}"
  if [ -n "$identity" ]; then
    codesign --force --sign "$identity" --identifier com.yuiyeong.chillasql "$bin" ||
      echo "cargo-runner: 서명하지 못했습니다. 서명 없이 실행합니다" >&2
  fi
fi
exec "$bin" "$@"
