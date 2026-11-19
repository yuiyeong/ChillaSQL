# ChillaSQL 구조

[기획서](spec.md) 3장의 구성요소가 코드의 어디에 놓이는지, 각 layer가 무엇에 의존할 수 있는지 정한다. 새 코드는 이 규칙에 맞춰 둔다.

## 1. 원칙

- 의존은 안쪽으로만 향한다. 바깥 layer가 안쪽 layer를 알고, 안쪽은 바깥을 모른다.
- layer는 crate가 아니라 `chilla-core` 안의 module로 나눈다. 혼자 쓰는 앱에 crate 여러 개는 과하다.
- `chilla-core`는 `tauri`에 의존하지 않는다. Tauri는 `src-tauri`만 안다.

## 2. Rust

```
src-tauri/src/                  command. use case를 부르는 일만 한다
crates/chilla-core/src/
├── domain/                     다른 layer와 I/O crate에 의존하지 않는다
├── application/                use case와 port trait. domain만 의존한다
└── infrastructure/             port 구현
```

| layer | 들어가는 것 | 의존할 수 있는 것 |
| --- | --- | --- |
| `domain` | 접속 정보, 세션, 쿼리 같은 개념과 규칙 | 다른 layer에 의존하지 않는다. 외부 crate는 I/O가 없는 것(`serde` 등)만 쓴다 |
| `application` | use case, port trait | `domain`. 외부 crate는 `tokio`의 runtime 기능(`sync`, `task`, `time`)만 쓴다. I/O는 하지 않는다 |
| `infrastructure` | port 구현: `tokio-postgres`, keychain, 터널 프로세스(`tokio::process`, `libc`), `pg_query` | `application`, `domain`, 외부 crate |
| `src-tauri` | Tauri command. 화면에서 받은 입력으로 use case를 부르고 결과를 돌려준다 | `chilla-core`, `tauri` |

### 기획서 3장 구성요소의 위치

| 구성요소 | `domain` | `application` | `infrastructure` |
| --- | --- | --- | --- |
| 세션 관리 | 세션과 접속 정보 | 세션을 열고 닫는 use case, DB 연결 port | `tokio-postgres`로 연결하는 구현, keychain 비밀번호 저장 |
| 터널 관리 | 터널 상태 | 터널을 띄우고 감시하는 use case, 터널 port | `tokio::process`로 터널 명령을 실행하는 구현 |
| 쿼리 실행 | 문장, 결과 행 | 실행, 취소, 결과 나눠 가져오기 use case, 문장 나누기 port | `tokio-postgres` 실행, `pg_query` 문장 나누기, `pg_query` 위험 쿼리 판별 |

### 의존 방향 검사

compiler는 같은 crate 안의 module 사이 의존 방향을 막지 못한다. `crates/chilla-core/tests/layer_deps.rs`가 `domain`과 `application`의 source를 `syn`으로 parse해서, `use`(묶거나 여러 줄에 걸친 것 포함)와 코드 안의 경로가 아래 경로로 시작하면 실패한다. `super::`로 올라가는 경로는 `crate::`로 보고, macro의 인자는 글자로 찾는다. 같은 test가 `chilla-core`의 `Cargo.toml`에 `tauri`가 없는지도 확인한다.

| layer | 쓸 수 없는 경로 |
| --- | --- |
| `domain` | `crate::application`, `crate::infrastructure`, `tokio`, `tokio_postgres`, `tokio_rustls`, `rustls`, `keyring_core`, `apple_native_keyring_store`, `toml`, `toml_edit`, `pg_query`, `std::fs`, `std::net`, `std::process`, `libc` |
| `application` | `crate::infrastructure`, `tokio_postgres`, `tokio_rustls`, `rustls`, `keyring_core`, `apple_native_keyring_store`, `toml`, `toml_edit`, `pg_query`, `std::fs`, `std::net`, `std::process`, `tokio::net`, `tokio::fs`, `tokio::process`, `libc` |

I/O를 하는 crate를 새로 들이면 이 표와 test의 목록에 함께 넣는다.

## 3. 화면

```
src/
├── features/<기능>/            component, store, hook
└── shared/
    └── api/                    Tauri API 호출
```

| 위치 | 들어가는 것 | 규칙 |
| --- | --- | --- |
| `src/features/<기능>/` | 그 기능의 component, store, hook | - |
| `src/shared/` | 기능에 속하지 않는 공용 코드 | - |
| `src/shared/api/` | Tauri command 호출과 event 구독 | 모든 `@tauri-apps/*` package는 여기서만 import한다 |
| `src/shared/i18n/` | 화면 문구 dictionary(`en.ts`)와 `t` | 화면 문구는 여기서만 정한다. component와 store에 문구를 직접 쓰지 않는다. `src/test/sourceRules.test.ts`가 한글 문구를 막는다 |
| `src/shared/ui/` | 공용 component | Task 4에서 만든다 |

모든 `@tauri-apps/*` package는 static import든 dynamic import든 `src/shared/api/`에서만 import한다. ESLint의 `no-restricted-imports`(static import)와 `no-restricted-syntax`(dynamic import)가 강제하며, `src/shared/api/` 밖에서 import하면 lint가 error를 낸다.

## 4. 검사

commit 전에 `pnpm check`를 통과시킨다.

| 명령 | 하는 일 |
| --- | --- |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit`으로 type만 확인한다 |
| `pnpm lint:rust` | `cargo clippy --workspace --all-targets -- -D warnings` |
| `pnpm format` | Prettier와 `cargo fmt`로 고쳐 쓴다 |
| `pnpm format:check` | 고치지 않고 형식만 확인한다 |
| `pnpm check` | `scripts/test-db.sh up`으로 test DB를 띄운 뒤 `format:check`, `lint`, `typecheck`, `lint:rust`, `test`, `cargo test`를 순서대로 실행한다. `cargo test`가 test DB에 접속하므로 Docker가 떠 있어야 한다 |

Rust는 `rustfmt`와 `clippy` 기본 설정을 쓴다. Prettier는 Tailwind class 정렬 plugin만 더하고 나머지는 기본값이다. `docs/`와 `*.md`는 Prettier가 건드리지 않는다.
