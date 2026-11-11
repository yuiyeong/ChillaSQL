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
| `application` | use case, port trait | `domain` |
| `infrastructure` | port 구현: `tokio-postgres`, keychain, 터널 프로세스, `pg_query` | `application`, `domain`, 외부 crate |
| `src-tauri` | Tauri command. 화면에서 받은 입력으로 use case를 부르고 결과를 돌려준다 | `chilla-core`, `tauri` |

### 기획서 3장 구성요소의 위치

| 구성요소 | `domain` | `application` | `infrastructure` |
| --- | --- | --- | --- |
| 세션 관리 | 세션과 접속 정보 | 세션을 열고 닫는 use case, DB 연결 port | `tokio-postgres`로 연결하는 구현, keychain 비밀번호 저장 |
| 터널 관리 | 터널 상태 | 터널을 띄우고 감시하는 use case, 터널 port | `tokio::process`로 터널 명령을 실행하는 구현 |
| 쿼리 실행 | 문장, 결과 행 | 실행, 취소, 결과 나눠 가져오기 use case, 문장 나누기 port | `tokio-postgres` 실행, `pg_query` 문장 나누기 |

### 의존 방향 검사

compiler는 같은 crate 안의 module 사이 의존 방향을 막지 못한다. M1에서 첫 module을 만들 때 `domain`이 `infrastructure`를 import하지 않는지 확인하는 test를 함께 넣는다.

## 3. 화면

```
src/
├── features/<기능>/            component, store, hook
└── shared/
    └── api/                    Tauri invoke 호출
```

| 위치 | 들어가는 것 | 규칙 |
| --- | --- | --- |
| `src/features/<기능>/` | 그 기능의 component, store, hook | - |
| `src/shared/` | 기능에 속하지 않는 공용 코드 | - |
| `src/shared/api/` | Tauri command 호출 | `@tauri-apps/api/core`의 `invoke`는 여기서만 import한다 |

`invoke` 위치 규칙은 ESLint의 `no-restricted-imports`가 강제한다. `src/shared/api/` 밖에서 `@tauri-apps/api`와 `@tauri-apps/api/core`를 import하면 모두 lint가 error를 낸다.

## 4. 검사

commit 전에 `pnpm check`를 통과시킨다.

| 명령 | 하는 일 |
| --- | --- |
| `pnpm lint` | ESLint |
| `pnpm lint:rust` | `cargo clippy --workspace --all-targets -- -D warnings` |
| `pnpm format` | Prettier와 `cargo fmt`로 고쳐 쓴다 |
| `pnpm format:check` | 고치지 않고 형식만 확인한다 |
| `pnpm check` | `format:check`, `lint`, `lint:rust`, `test`, `cargo test`를 순서대로 실행한다 |

Rust는 `rustfmt`와 `clippy` 기본 설정을 쓴다. Prettier는 Tailwind class 정렬 plugin만 더하고 나머지는 기본값이다. `docs/`와 `*.md`는 Prettier가 건드리지 않는다.
