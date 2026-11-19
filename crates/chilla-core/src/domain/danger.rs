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
    /// "SEQUENCE", "FUNCTION", "TYPE", "EXTENSION", "DATABASE". 그 밖의 object는 "".
    Drop {
        kind: String,
        names: Vec<String>,
    },
    Truncate {
        tables: Vec<String>,
    },
}
