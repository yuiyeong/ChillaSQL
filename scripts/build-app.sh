#!/bin/sh
# `.app`을 만들고 dev 빌드와 같은 identity, identifier로 서명한다. 키체인이 dev 빌드와 같은 앱으로 보게 한다.
# 사용법: scripts/build-app.sh [--debug]
# 결과: target/release/bundle/macos/ChillaSQL.app (`--debug`면 target/debug/...)
set -e
cd "$(dirname "$0")/.."

case "$#:$1" in
  0:) profile=release ;;
  1:--debug) profile=debug ;;
  *)
    echo "사용법: $0 [--debug]" >&2
    exit 2
    ;;
esac

pnpm tauri build --bundles app "$@"

app="target/$profile/bundle/macos/ChillaSQL.app"
. scripts/signing-identity.sh
if [ -z "$signing_identity" ]; then
  echo "build-app: code signing identity가 없어 서명하지 않았습니다. 키체인이 매번 확인 창을 띄울 수 있습니다" >&2
  exit 0
fi
codesign --force --deep --sign "$signing_identity" --identifier com.yuiyeong.chillasql "$app"
echo "build-app: $app"
