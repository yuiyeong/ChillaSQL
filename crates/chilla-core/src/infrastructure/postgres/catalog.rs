//! 스키마 트리와 자동완성의 catalog를 읽는 SQL. PostgreSQL 11 이상을 가정한다(`prokind`).

use tokio_postgres::Client;
use tokio_postgres::types::ToSql;

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

/// relation마다 한 줄, 컬럼은 정의 순서의 배열 셋(이름, type, pk)이다. 컬럼이 없는 테이블은 빈
/// 배열이다. partition은 뺀다.
fn relations_sql() -> String {
    format!(
        "SELECT c.oid, n.nspname::text, c.relname::text, c.relkind::text, \
                COALESCE(array_agg(a.attname::text ORDER BY a.attnum) \
                    FILTER (WHERE a.attname IS NOT NULL), '{{}}'), \
                COALESCE(array_agg(format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum) \
                    FILTER (WHERE a.attname IS NOT NULL), '{{}}'), \
                COALESCE(array_agg(COALESCE(a.attnum = ANY (i.indkey), false) ORDER BY a.attnum) \
                    FILTER (WHERE a.attname IS NOT NULL), '{{}}') \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
         LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary \
         WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm') AND NOT c.relispartition AND {} \
         GROUP BY c.oid, n.nspname, c.relname, c.relkind \
         ORDER BY n.nspname, c.relname",
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

/// 쿼리는 한 연결에 함께 보낸다(tokio-postgres가 pipeline으로 보낸다). 터널 너머에서 왕복이 준다.
pub(super) async fn read_catalog(client: &Client) -> Result<Catalog, QueryError> {
    let schemas_sql = schemas_sql();
    let relations_sql = relations_sql();
    let (schemas, search_path, reserved_words, functions, relations) = tokio::try_join!(
        query(client, &schemas_sql, &[]),
        query(client, SEARCH_PATH_SQL, &[]),
        query(client, RESERVED_SQL, &[]),
        query(client, FUNCTIONS_SQL, &[]),
        query(client, &relations_sql, &[]),
    )?;
    let strings = |rows: Vec<tokio_postgres::Row>| -> Vec<String> {
        rows.iter().map(|row| row.get(0)).collect()
    };
    Ok(Catalog {
        search_path: strings(search_path),
        schemas: strings(schemas),
        relations: relations.iter().map(relation).collect(),
        functions: functions
            .iter()
            .map(|row| FunctionName {
                schema: row.get(0),
                name: row.get(1),
            })
            .collect(),
        reserved_words: strings(reserved_words),
    })
}

fn relation(row: &tokio_postgres::Row) -> Relation {
    let kind: String = row.get(3);
    let names: Vec<String> = row.get(4);
    let types: Vec<String> = row.get(5);
    let keys: Vec<bool> = row.get(6);
    Relation {
        oid: row.get(0),
        schema: row.get(1),
        name: row.get(2),
        kind: relation_kind(&kind),
        columns: names
            .into_iter()
            .zip(types)
            .zip(keys)
            .map(|((name, type_name), primary_key)| CatalogColumn {
                name,
                type_name,
                primary_key,
            })
            .collect(),
    }
}

pub(super) async fn read_table_details(
    client: &Client,
    relation: u32,
) -> Result<TableDetails, QueryError> {
    let params: [&(dyn ToSql + Sync); 1] = [&relation];
    let (indexes, constraints) = tokio::try_join!(
        query(client, INDEXES_SQL, &params),
        query(client, CONSTRAINTS_SQL, &params),
    )?;
    let indexes = indexes
        .iter()
        .map(|row| IndexInfo {
            name: row.get(0),
            definition: row.get(1),
            unique: row.get(2),
            primary: row.get(3),
        })
        .collect();
    let constraints = constraints
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
    params: &[&(dyn ToSql + Sync)],
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
