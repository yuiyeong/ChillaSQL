/// 실행 전에 확인할 위험한 문장. 이름은 문장에 쓴 그대로(`schema.table`이면 그대로, 따옴표는 뺌)다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Danger {
    UpdateWithoutWhere {
        table: String,
    },
    DeleteWithoutWhere {
        table: String,
    },
    /// `kind`는 SQL keyword다: "TABLE", "VIEW", "MATERIALIZED VIEW", "INDEX", "SCHEMA",
    /// "SEQUENCE", "FUNCTION", "TYPE", "EXTENSION", "DATABASE", "ROLE", "TABLESPACE". 그 밖의 object는 "".
    /// `DROP OWNED BY`는 "OWNED"이고 `names`는 지울 object를 가진 role이다.
    Drop {
        kind: String,
        names: Vec<String>,
    },
    Truncate {
        tables: Vec<String>,
    },
}
