//! 스키마 트리와 자동완성의 catalog를 읽는 SQL. PostgreSQL 11 이상을 가정한다(`prokind`).

use tokio_postgres::Client;
use tokio_postgres::types::ToSql;

use super::query_error;
use crate::application::QueryError;
use crate::domain::{
    Catalog, CatalogColumn, ConstraintInfo, ConstraintKind, DdlColumn, DdlConstraint, FunctionName,
    Generated, Identity, IndexInfo, PartitionOf, Relation, RelationDdl, RelationKind, TableDetails,
    TypeInfo,
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

/// 받은 순서대로 돌려준다(JOIN만으로는 순서가 정해지지 않는다). pg_type에 없는 OID는 빠진다.
const TYPES_SQL: &str = "\
    SELECT m.oid, m.typmod, format_type(m.oid, m.typmod), t.typcategory \
    FROM unnest($1::oid[], $2::int4[]) WITH ORDINALITY AS m(oid, typmod, i) \
    JOIN pg_type t ON t.oid = m.oid \
    ORDER BY m.i";

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

/// DDL을 보이는 relation 하나. 이름은 `quote_ident`로 감싸고 schema를 붙인다. 부모는 상속 순서다
/// (partition이면 하나뿐이고 그것이 `PARTITION OF`의 부모다).
const DDL_RELATION_SQL: &str = "\
    SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname), c.relkind::text, \
           c.relpersistence = 'u', COALESCE(c.reloptions, '{}'), c.relispartition, \
           pg_get_partkeydef(c.oid), \
           CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END, \
           CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END, \
           ARRAY(SELECT quote_ident(pn.nspname) || '.' || quote_ident(p.relname) \
                 FROM pg_inherits i \
                 JOIN pg_class p ON p.oid = i.inhparent \
                 JOIN pg_namespace pn ON pn.oid = p.relnamespace \
                 WHERE i.inhrelid = c.oid ORDER BY i.inhseqno), \
           quote_literal(obj_description(c.oid, 'pg_class')) \
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
    WHERE c.oid = $1 AND c.relkind IN ('r', 'p', 'v', 'm')";

/// 테이블이 정의한 컬럼. partition의 컬럼과 부모에게서만 받은 컬럼(`NOT attislocal`)은 쓰지 않는다.
/// collation은 type의 기본과 다를 때만 있고 `pg_catalog`가 아니면 schema를 붙인다.
/// generated 컬럼의 `adbin`은 기본값이 아니라 생성 식이다.
const DDL_COLUMNS_SQL: &str = "\
    SELECT quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), \
           CASE WHEN a.attcollation <> t.typcollation THEN \
               CASE WHEN cn.nspname = 'pg_catalog' THEN '' \
                    ELSE quote_ident(cn.nspname) || '.' END || quote_ident(co.collname) \
           END, \
           a.attnotnull, COALESCE(a.attnum = ANY (pk.indkey), false), \
           a.attidentity::text, a.attgenerated::text, pg_get_expr(d.adbin, d.adrelid) \
    FROM pg_class c \
    JOIN pg_attribute a ON a.attrelid = c.oid \
    JOIN pg_type t ON t.oid = a.atttypid \
    LEFT JOIN pg_collation co ON co.oid = a.attcollation \
    LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace \
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
    LEFT JOIN pg_index pk ON pk.indrelid = c.oid AND pk.indisprimary \
    WHERE c.oid = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition \
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attislocal \
    ORDER BY a.attnum";

/// 이 relation이 정의한 제약조건. PostgreSQL 18의 NOT NULL 제약(`n`)은 컬럼의 NOT NULL로 쓰고,
/// 부모나 partitioned table에게서 받은 것(`NOT conislocal`)은 쓰지 않는다.
const DDL_CONSTRAINTS_SQL: &str = "\
    SELECT quote_ident(conname), pg_get_constraintdef(oid) \
    FROM pg_constraint \
    WHERE conrelid = $1 AND conislocal AND contype IN ('p', 'u', 'f', 'c', 'x') \
    ORDER BY position(contype::text IN 'pufcx'), conname";

/// 제약조건이 만든 인덱스와 partition이 부모의 인덱스에 attach한 인덱스는 뺀다.
/// partitioned table의 인덱스는 `ON ONLY`를 뗀다. `ON ONLY`로 만들면 partition에 내려가지 않아
/// 부모 인덱스가 invalid로 남는다. 첫 `ON ONLY`는 `CREATE INDEX name` 바로 뒤다.
const DDL_INDEXES_SQL: &str = "\
    SELECT CASE WHEN c.relkind = 'p' \
                THEN regexp_replace(pg_get_indexdef(i.indexrelid), ' ON ONLY ', ' ON ') \
                ELSE pg_get_indexdef(i.indexrelid) END \
    FROM pg_index i \
    JOIN pg_class c ON c.oid = i.indrelid \
    JOIN pg_class ic ON ic.oid = i.indexrelid \
    WHERE i.indrelid = $1 \
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid \
                      AND k.conrelid = i.indrelid AND k.contype IN ('p', 'u', 'x')) \
      AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = i.indexrelid) \
    ORDER BY ic.relname";

/// partition이 부모에게서 받은 trigger(`tgparentid`)는 뺀다. `pretty`를 쓰지 않는 것은 그래야
/// search_path에 있는 테이블에도 schema를 붙이기 때문이다.
const DDL_TRIGGERS_SQL: &str = "\
    SELECT pg_get_triggerdef(oid) FROM pg_trigger \
    WHERE tgrelid = $1 AND NOT tgisinternal AND tgparentid = 0 \
    ORDER BY tgname";

const DDL_COLUMN_COMMENTS_SQL: &str = "\
    SELECT quote_ident(attname), quote_literal(col_description(attrelid, attnum)) \
    FROM pg_attribute \
    WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped \
      AND col_description(attrelid, attnum) IS NOT NULL \
    ORDER BY attnum";

/// relation 하나의 DDL 재료. 테이블, partitioned table, view, materialized view가 아니면 `None`이다.
pub(super) async fn read_ddl(
    client: &Client,
    relation: u32,
) -> Result<Option<RelationDdl>, QueryError> {
    let params: [&(dyn ToSql + Sync); 1] = [&relation];
    let (relations, columns, constraints, indexes, triggers, column_comments) = tokio::try_join!(
        query(client, DDL_RELATION_SQL, &params),
        query(client, DDL_COLUMNS_SQL, &params),
        query(client, DDL_CONSTRAINTS_SQL, &params),
        query(client, DDL_INDEXES_SQL, &params),
        query(client, DDL_TRIGGERS_SQL, &params),
        query(client, DDL_COLUMN_COMMENTS_SQL, &params),
    )?;
    let Some(row) = relations.first() else {
        return Ok(None);
    };
    let kind: String = row.get(1);
    let is_partition: bool = row.get(4);
    let mut parents: Vec<String> = row.get(8);
    // partition의 부모는 하나다. 같은 쿼리에서 읽었으므로 비어 있지 않다.
    let partition_of = match is_partition && !parents.is_empty() {
        true => Some(PartitionOf {
            parent: parents.remove(0),
            bound: row.get(6),
        }),
        false => None,
    };
    let strings = |rows: Vec<tokio_postgres::Row>| -> Vec<String> {
        rows.iter().map(|row| row.get(0)).collect()
    };
    Ok(Some(RelationDdl {
        name: row.get(0),
        kind: relation_kind(&kind),
        unlogged: row.get(2),
        columns: columns.iter().map(ddl_column).collect(),
        constraints: constraints
            .iter()
            .map(|row| DdlConstraint {
                name: row.get(0),
                definition: row.get(1),
            })
            .collect(),
        inherits: parents,
        partition_of,
        partition_by: row.get(5),
        options: row.get(3),
        view_definition: row.get(7),
        indexes: strings(indexes),
        triggers: strings(triggers),
        comment: row.get(9),
        column_comments: column_comments
            .iter()
            .map(|row| (row.get(0), row.get(1)))
            .collect(),
    }))
}

fn ddl_column(row: &tokio_postgres::Row) -> DdlColumn {
    let identity: String = row.get(5);
    let generated: String = row.get(6);
    let expression: Option<String> = row.get(7);
    let (default, generated) = match generated.as_str() {
        "s" | "v" => (
            None,
            Some(Generated {
                expression: expression.unwrap_or_default(),
                stored: generated == "s",
            }),
        ),
        _ => (expression, None),
    };
    DdlColumn {
        name: row.get(0),
        type_name: row.get(1),
        collation: row.get(2),
        not_null: row.get(3),
        primary_key: row.get(4),
        default,
        identity: match identity.as_str() {
            "a" => Some(Identity::Always),
            "d" => Some(Identity::ByDefault),
            _ => None,
        },
        generated,
    }
}

pub(super) async fn describe_types(
    client: &Client,
    types: &[(u32, i32)],
) -> Result<Vec<TypeInfo>, QueryError> {
    if types.is_empty() {
        return Ok(Vec::new());
    }
    let oids: Vec<u32> = types.iter().map(|&(oid, _)| oid).collect();
    let modifiers: Vec<i32> = types.iter().map(|&(_, modifier)| modifier).collect();
    let params: [&(dyn ToSql + Sync); 2] = [&oids, &modifiers];
    let rows = query(client, TYPES_SQL, &params).await?;
    Ok(rows
        .iter()
        .map(|row| {
            // typcategory는 NOT NULL인 "char"(1 byte)이고 ASCII 한 글자다.
            let category: i8 = row.get(3);
            TypeInfo {
                oid: row.get(0),
                modifier: row.get(1),
                name: row.get(2),
                category: char::from(category as u8),
            }
        })
        .collect())
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
