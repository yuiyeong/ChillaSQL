//! 스키마 트리와 자동완성의 catalog를 읽는 SQL. PostgreSQL 11 이상을 가정한다(`prokind`).

use tokio_postgres::Client;

use super::query_error;
use crate::application::QueryError;
use crate::domain::{
    Catalog, CatalogColumn, ConstraintInfo, ConstraintKind, FunctionName, IndexInfo, Relation,
    RelationKind, TableDetails,
};

/// 트리와 테이블 자동완성에서 빼는 schema. `alias`는 `pg_namespace`의 별칭이다.
fn user_schema(alias: &str) -> String {
    format!(
        "{alias}.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
         AND {alias}.nspname NOT LIKE 'pg\\_temp\\_%' \
         AND {alias}.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'"
    )
}

/// relation과 컬럼. 컬럼이 없는 테이블도 한 줄(`attname`이 NULL)로 남는다. partition은 뺀다.
fn relations_sql() -> String {
    format!(
        "SELECT c.oid, n.nspname::text, c.relname::text, c.relkind::text, a.attname::text, \
                format_type(a.atttypid, a.atttypmod), COALESCE(a.attnum = ANY (i.indkey), false) \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
         LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary \
         WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm') AND NOT c.relispartition AND {} \
         ORDER BY n.nspname, c.relname, a.attnum",
        user_schema("n")
    )
}

fn schemas_sql() -> String {
    format!(
        "SELECT n.nspname::text FROM pg_namespace n WHERE {} ORDER BY n.nspname",
        user_schema("n")
    )
}

/// 자동완성할 함수. `pg_catalog`도 넣되 사람이 SQL에 쓰지 않는 함수(type I/O, handler, 연산자
/// 구현, aggregate 보조 함수)는 뺀다. pseudo-type은 이름으로 골라 버전마다 없는 이름이 있어도 된다.
const FUNCTIONS_SQL: &str = "\
    WITH hidden AS ( \
        SELECT oid FROM pg_type WHERE typname IN ('internal', 'cstring', 'trigger', \
            'event_trigger', 'language_handler', 'fdw_handler', 'index_am_handler', \
            'table_am_handler', 'tsm_handler') \
    ), support AS ( \
        SELECT unnest(ARRAY[aggtransfn, aggfinalfn, aggcombinefn, aggserialfn, aggdeserialfn, \
            aggmtransfn, aggminvtransfn, aggmfinalfn]::oid[]) AS oid FROM pg_aggregate \
    ) \
    SELECT DISTINCT n.nspname::text, p.proname::text \
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
    WHERE p.prokind IN ('f', 'a', 'w') \
      AND n.nspname NOT IN ('information_schema', 'pg_toast') \
      AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%' \
      AND NOT EXISTS (SELECT 1 FROM pg_operator o WHERE o.oprcode = p.oid) \
      AND NOT EXISTS (SELECT 1 FROM support s WHERE s.oid = p.oid) \
      AND p.prorettype NOT IN (SELECT oid FROM hidden) \
      AND NOT (p.proargtypes::oid[] && ARRAY(SELECT oid FROM hidden)) \
    ORDER BY 1, 2";

const SEARCH_PATH_SQL: &str =
    "SELECT s::text FROM unnest(current_schemas(false)) WITH ORDINALITY AS t(s, i) ORDER BY i";

const RESERVED_SQL: &str = "SELECT word FROM pg_get_keywords() WHERE catcode <> 'U' ORDER BY word";

const INDEXES_SQL: &str = "\
    SELECT ic.relname::text, pg_get_indexdef(i.indexrelid), i.indisunique, i.indisprimary \
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid \
    WHERE i.indrelid = $1 ORDER BY ic.relname";

/// domain의 제약조건은 `conrelid`가 0이므로 `contypid = 0`으로 뺀다.
const CONSTRAINTS_SQL: &str = "\
    SELECT conname::text, contype::text, pg_get_constraintdef(oid) \
    FROM pg_constraint \
    WHERE conrelid = $1 AND contypid = 0 AND contype IN ('p', 'f', 'u', 'c', 'x') ORDER BY conname";

pub(super) async fn read_catalog(client: &Client) -> Result<Catalog, QueryError> {
    let strings = |rows: Vec<tokio_postgres::Row>| -> Vec<String> {
        rows.iter().map(|row| row.get(0)).collect()
    };
    let schemas = strings(query(client, &schemas_sql(), &[]).await?);
    let search_path = strings(query(client, SEARCH_PATH_SQL, &[]).await?);
    let reserved_words = strings(query(client, RESERVED_SQL, &[]).await?);
    let functions = query(client, FUNCTIONS_SQL, &[])
        .await?
        .iter()
        .map(|row| FunctionName {
            schema: row.get(0),
            name: row.get(1),
        })
        .collect();

    let mut relations: Vec<Relation> = Vec::new();
    for row in query(client, &relations_sql(), &[]).await? {
        let oid: u32 = row.get(0);
        if relations.last().is_none_or(|last| last.oid != oid) {
            let kind: String = row.get(3);
            relations.push(Relation {
                oid,
                schema: row.get(1),
                name: row.get(2),
                kind: relation_kind(&kind),
                columns: Vec::new(),
            });
        }
        let name: Option<String> = row.get(4);
        if let (Some(name), Some(relation)) = (name, relations.last_mut()) {
            relation.columns.push(CatalogColumn {
                name,
                type_name: row.get(5),
                primary_key: row.get(6),
            });
        }
    }

    Ok(Catalog {
        search_path,
        schemas,
        relations,
        functions,
        reserved_words,
    })
}

pub(super) async fn read_table_details(
    client: &Client,
    relation: u32,
) -> Result<TableDetails, QueryError> {
    let indexes = query(client, INDEXES_SQL, &[&relation])
        .await?
        .iter()
        .map(|row| IndexInfo {
            name: row.get(0),
            definition: row.get(1),
            unique: row.get(2),
            primary: row.get(3),
        })
        .collect();
    let constraints = query(client, CONSTRAINTS_SQL, &[&relation])
        .await?
        .iter()
        .filter_map(|row| {
            let kind: String = row.get(1);
            Some(ConstraintInfo {
                name: row.get(0),
                kind: constraint_kind(&kind)?,
                definition: row.get(2),
            })
        })
        .collect();
    Ok(TableDetails {
        indexes,
        constraints,
    })
}

async fn query(
    client: &Client,
    sql: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Result<Vec<tokio_postgres::Row>, QueryError> {
    client.query(sql, params).await.map_err(query_error)
}

/// SQL이 고른 relkind만 온다.
fn relation_kind(relkind: &str) -> RelationKind {
    match relkind {
        "p" => RelationKind::PartitionedTable,
        "f" => RelationKind::ForeignTable,
        "v" => RelationKind::View,
        "m" => RelationKind::MaterializedView,
        _ => RelationKind::Table,
    }
}

fn constraint_kind(contype: &str) -> Option<ConstraintKind> {
    match contype {
        "p" => Some(ConstraintKind::PrimaryKey),
        "f" => Some(ConstraintKind::ForeignKey),
        "u" => Some(ConstraintKind::Unique),
        "c" => Some(ConstraintKind::Check),
        "x" => Some(ConstraintKind::Exclusion),
        _ => None,
    }
}
