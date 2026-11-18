# source해서 쓴다. `signing_identity`에 이 Mac의 code signing identity를 둔다.
# `CHILLA_DEV_IDENTITY`가 있으면 그것, 없으면 첫 유효 identity, 없으면 빈 문자열이다.
# dev 빌드(`cargo-runner.sh`)와 `.app`(`build-app.sh`)이 같은 identity로 서명해야 키체인이 같은 앱으로 본다.
signing_identity="${CHILLA_DEV_IDENTITY:-$(security find-identity -v -p codesigning | awk 'NR == 1 && $2 ~ /^[0-9A-F]+$/ { print $2 }')}"
