//! 결과 표의 셀 편집이 필요로 하는 테이블 정보.

use super::{RelationKind, Row, ServerError, TxStatus};

/// 편집 대상이 될 수 있는 relation 하나. 결과 열의 table OID로 찾는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditTable {
    pub oid: u32,
    /// `quote_ident(schema) || '.' || quote_ident(relname)`. SQL에 쓴다.
    pub qualified_name: String,
    /// relname 그대로. 화면 문구에 쓴다.
    pub name: String,
    pub kind: RelationKind,
    /// attnum 순. 지운 컬럼은 없다.
    pub columns: Vec<EditColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditColumn {
    /// `pg_attribute.attnum`. 결과 열의 `column_number`와 맞춘다.
    pub number: i16,
    pub name: String,
    /// `quote_ident(attname)`
    pub quoted_name: String,
    pub primary_key: bool,
    /// generated 컬럼과 `GENERATED ALWAYS` identity 컬럼은 false
    pub updatable: bool,
}

/// 셀 편집의 UPDATE를 한 단위로 보낸 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// 문장마다 `RETURNING` 행 하나, 보낸 순서.
    Applied {
        rows: Vec<Row>,
    },
    /// `index` 문장이 바꾼 행이 1이 아니다. 모두 되돌렸다.
    WrongRowCount {
        index: usize,
        rows: u64,
    },
    /// 서버가 거절했다. 모두 되돌렸다. `index`가 None이면 문장이 아니라 앞뒤의 `BEGIN`, `SAVEPOINT`,
    /// `COMMIT`이 실패했다(deferred constraint는 `COMMIT`에서 실패한다).
    Failed {
        index: Option<usize>,
        error: ServerError,
    },
    /// 실패한 트랜잭션이라 보내지 않았다.
    TransactionFailed,
    /// 이 세션에 열린 쿼리가 있어 보내지 않았다.
    Busy,
    ConnectionLost {
        message: String,
    },
    /// 서버의 오류가 아닌 오류. 연결은 그대로다.
    Client {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyResult {
    pub outcome: ApplyOutcome,
    /// 끝난 뒤 서버가 알려 준 트랜잭션 상태. 연결이 끊겼거나 보내지 않았으면(`Busy`) `None`이다.
    pub tx: Option<TxStatus>,
}
