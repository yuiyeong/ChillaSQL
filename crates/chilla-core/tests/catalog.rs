//! 스키마 트리와 자동완성의 catalog SQL을 실제 구성(test DB)으로 검사한다.
//! test DB는 `scripts/test-db.sh up`으로 띄운다. test마다 `m7_cat_` 이름의 schema를 따로 쓴다.

mod support;

use chilla_core::application::DbConnection;
use chilla_core::domain::{
    CatalogColumn, ConstraintKind, EditTable, FunctionName, Relation, RelationKind, TableDetails,
    TypeInfo,
};
use support::{admin, connect};

/// schema를 비우고 `sql`로 다시 만든다.
async fn reset_schema(schema: &str, sql: &str) {
    let admin = admin().await;
    admin
        .batch_execute(&format!(
            "DROP SCHEMA IF EXISTS {schema} CASCADE; CREATE SCHEMA {schema}; SET search_path = {schema}; {sql}"
        ))
        .await
        .unwrap();
}

fn column(name: &str, type_name: &str, primary_key: bool) -> CatalogColumn {
    CatalogColumn {
        name: name.into(),
        type_name: type_name.into(),
        primary_key,
    }
}

fn function(schema: &str, name: &str) -> FunctionName {
    FunctionName {
        schema: schema.into(),
        name: name.into(),
    }
}

#[tokio::test]
async fn catalog_lists_user_objects() {
    reset_schema(
        "m7_cat_a",
        r#"
        CREATE TABLE "Order Items" (id bigint PRIMARY KEY, "Note" text);
        CREATE VIEW v_items AS SELECT id FROM "Order Items";
        CREATE MATERIALIZED VIEW mv_items AS SELECT id FROM "Order Items";
        CREATE TABLE events (at date) PARTITION BY RANGE (at);
        CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
        CREATE FUNCTION m7_cat_a.add_one(int) RETURNS int LANGUAGE sql AS 'SELECT $1 + 1';
        "#,
    )
    .await;
    let db = connect().await;
    let catalog = db.read_catalog().await.unwrap();

    assert!(catalog.schemas.contains(&"m7_cat_a".to_string()));
    assert!(catalog.schemas.contains(&"public".to_string()));
    for hidden in ["pg_catalog", "information_schema", "pg_toast"] {
        assert!(!catalog.schemas.contains(&hidden.to_string()), "{hidden}");
    }

    let relations: Vec<&Relation> = catalog
        .relations
        .iter()
        .filter(|r| r.schema == "m7_cat_a")
        .collect();
    let summary: Vec<(&str, RelationKind)> = relations
        .iter()
        .map(|r| (r.name.as_str(), r.kind))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("Order Items", RelationKind::Table),
            ("events", RelationKind::PartitionedTable),
            ("mv_items", RelationKind::MaterializedView),
            ("v_items", RelationKind::View),
        ]
    );
    assert_eq!(
        relations[0].columns,
        vec![column("id", "bigint", true), column("Note", "text", false)]
    );
    assert_ne!(relations[0].oid, 0);

    for wanted in [
        function("m7_cat_a", "add_one"),
        function("pg_catalog", "date_trunc"),
        function("pg_catalog", "jsonb_build_object"),
        function("pg_catalog", "count"),
    ] {
        assert!(catalog.functions.contains(&wanted), "{wanted:?}");
    }
    for unwanted in [
        "int4pl",
        "textin",
        "array_in",
        "heap_tableam_handler",
        "int4_sum",
    ] {
        assert!(
            !catalog.functions.iter().any(|f| f.name == unwanted),
            "{unwanted}"
        );
    }

    assert_eq!(catalog.search_path, vec!["public".to_string()]);
    assert!(catalog.reserved_words.contains(&"select".to_string()));
    assert!(catalog.reserved_words.contains(&"user".to_string()));
    assert!(!catalog.reserved_words.contains(&"id".to_string()));
}

#[tokio::test]
async fn table_details_lists_indexes_and_constraints() {
    reset_schema(
        "m7_cat_b",
        r#"
        CREATE TABLE parent (id int PRIMARY KEY);
        CREATE TABLE child (
            id int PRIMARY KEY,
            email text NOT NULL UNIQUE,
            amount int CHECK (amount > 0),
            parent_id int REFERENCES parent,
            created_at date
        );
        CREATE INDEX child_created ON child (created_at);
        "#,
    )
    .await;
    let db = connect().await;
    let catalog = db.read_catalog().await.unwrap();
    let child = catalog
        .relations
        .iter()
        .find(|r| r.schema == "m7_cat_b" && r.name == "child")
        .unwrap();
    let details = db.read_table_details(child.oid).await.unwrap();

    let indexes: Vec<(&str, bool, bool)> = details
        .indexes
        .iter()
        .map(|i| (i.name.as_str(), i.unique, i.primary))
        .collect();
    assert_eq!(
        indexes,
        vec![
            ("child_created", false, false),
            ("child_email_key", true, false),
            ("child_pkey", true, true),
        ]
    );
    assert_eq!(
        details.indexes[0].definition,
        "CREATE INDEX child_created ON m7_cat_b.child USING btree (created_at)"
    );

    let constraints: Vec<(&str, ConstraintKind)> = details
        .constraints
        .iter()
        .map(|c| (c.name.as_str(), c.kind))
        .collect();
    assert_eq!(
        constraints,
        vec![
            ("child_amount_check", ConstraintKind::Check),
            ("child_email_key", ConstraintKind::Unique),
            ("child_parent_id_fkey", ConstraintKind::ForeignKey),
            ("child_pkey", ConstraintKind::PrimaryKey),
        ]
    );
    assert_eq!(
        details.constraints[2].definition,
        "FOREIGN KEY (parent_id) REFERENCES m7_cat_b.parent(id)"
    );
}

#[tokio::test]
async fn table_details_of_an_unknown_oid_are_empty() {
    let db = connect().await;
    assert_eq!(
        db.read_table_details(0).await.unwrap(),
        TableDetails {
            indexes: vec![],
            constraints: vec![],
        }
    );
}

fn type_info(oid: u32, modifier: i32, name: &str, category: char) -> TypeInfo {
    TypeInfo {
        oid,
        modifier,
        name: name.into(),
        category,
    }
}

#[tokio::test]
async fn describe_types_formats_with_typmod() {
    let db = connect().await;
    let types = db
        .describe_types(&[
            (23, -1),
            (1043, 259),
            (1700, 655366),
            (1184, -1),
            (1009, -1),
            (3802, -1),
            (114, -1),
        ])
        .await
        .unwrap();

    assert_eq!(
        types,
        vec![
            type_info(23, -1, "integer", 'N'),
            type_info(1043, 259, "character varying(255)", 'S'),
            type_info(1700, 655366, "numeric(10,2)", 'N'),
            type_info(1184, -1, "timestamp with time zone", 'D'),
            type_info(1009, -1, "text[]", 'A'),
            type_info(3802, -1, "jsonb", 'U'),
            type_info(114, -1, "json", 'U'),
        ]
    );
}

#[tokio::test]
async fn describe_types_skips_unknown_oids() {
    let db = connect().await;
    let types = db
        .describe_types(&[(0, -1), (4_000_000_000, -1), (23, -1)])
        .await
        .unwrap();

    assert_eq!(types, vec![type_info(23, -1, "integer", 'N')]);
    assert_eq!(db.describe_types(&[]).await.unwrap(), vec![]);
}

#[tokio::test]
async fn describe_types_of_a_domain_and_enum() {
    reset_schema(
        "m8_types_a",
        r#"
        CREATE TYPE mood AS ENUM ('happy', 'sad');
        CREATE DOMAIN positive AS int CHECK (VALUE > 0);
        "#,
    )
    .await;
    let admin = admin().await;
    let oids = admin
        .query(
            "SELECT 'm8_types_a.mood'::regtype::oid, 'm8_types_a.positive'::regtype::oid",
            &[],
        )
        .await
        .unwrap();
    let mood: u32 = oids[0].get(0);
    let positive: u32 = oids[0].get(1);

    let db = connect().await;
    // search_path에 없는 schema의 type은 schema를 붙여 쓴다.
    let types = db
        .describe_types(&[(mood, -1), (positive, -1)])
        .await
        .unwrap();

    assert_eq!(
        types,
        vec![
            type_info(mood, -1, "m8_types_a.mood", 'E'),
            type_info(positive, -1, "m8_types_a.positive", 'N'),
        ]
    );
}

/// M10 셀 편집 test가 함께 쓰는 schema. 읽기만 하는 test들이 한 번 만든 것을 같이 본다.
const EDIT_SCHEMA: &str = "m10_edit";

/// `m10_edit`를 만들고 `name`의 OID를 돌려준다. `users`는 attnum이 1 2 4 5 6이다(3번을 지웠다).
async fn edit_fixture() -> std::collections::HashMap<String, u32> {
    reset_schema(
        EDIT_SCHEMA,
        r#"
        CREATE TABLE users (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            email text NOT NULL,
            dropped text,
            name text,
            doubled int GENERATED ALWAYS AS (length(email) * 2) STORED,
            note text
        );
        ALTER TABLE users DROP COLUMN dropped;
        CREATE TABLE orders (id int PRIMARY KEY, user_id int);
        CREATE TABLE nopk (a int, b text);
        CREATE TABLE parted (id int, k int, v text, PRIMARY KEY (id, k)) PARTITION BY RANGE (id);
        CREATE TABLE parted_1 PARTITION OF parted FOR VALUES FROM (0) TO (100);
        CREATE VIEW users_v AS SELECT id, email FROM users;
        CREATE MATERIALIZED VIEW users_mv AS SELECT id, email FROM users;
        CREATE TABLE "Order Items" (id int PRIMARY KEY, "Note" text);
        "#,
    )
    .await;
    let rows = admin()
        .await
        .query(
            "SELECT c.relname::text, c.oid FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1",
            &[&EDIT_SCHEMA],
        )
        .await
        .unwrap();
    rows.iter().map(|r| (r.get(0), r.get(1))).collect()
}

async fn describe(oids: &[u32]) -> Vec<EditTable> {
    connect().await.describe_tables(oids).await.unwrap()
}

fn table(tables: &[EditTable], oid: u32) -> &EditTable {
    tables.iter().find(|t| t.oid == oid).unwrap()
}

async fn drop_edit_schema() {
    admin()
        .await
        .batch_execute(&format!("DROP SCHEMA IF EXISTS {EDIT_SCHEMA} CASCADE"))
        .await
        .unwrap();
}

// `m10_edit`를 쓰는 test는 한 test 함수에 모아 순서대로 돌린다. cargo test가 병렬로 돌려도
// schema를 다시 만드는 사이에 다른 test가 읽지 않는다.
#[tokio::test]
async fn describe_tables_reads_edit_columns() {
    let oids = edit_fixture().await;

    // describes_columns_by_number
    let tables = describe(&[oids["users"]]).await;
    let users = table(&tables, oids["users"]);
    assert_eq!(users.name, "users");
    assert_eq!(users.qualified_name, "m10_edit.users");
    assert_eq!(users.kind, RelationKind::Table);
    let summary: Vec<(i16, &str, bool, bool)> = users
        .columns
        .iter()
        .map(|c| (c.number, c.name.as_str(), c.primary_key, c.updatable))
        .collect();
    assert_eq!(
        summary,
        vec![
            (1, "id", true, false),
            (2, "email", false, true),
            (4, "name", false, true),
            (5, "doubled", false, false),
            (6, "note", false, true),
        ]
    );

    // composite_primary_key
    let tables = describe(&[oids["parted"], oids["parted_1"]]).await;
    let parted = table(&tables, oids["parted"]);
    assert_eq!(parted.kind, RelationKind::PartitionedTable);
    let keys: Vec<(&str, bool)> = parted
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.primary_key))
        .collect();
    assert_eq!(keys, vec![("id", true), ("k", true), ("v", false)]);
    let part = table(&tables, oids["parted_1"]);
    assert_eq!(part.kind, RelationKind::Table);
    assert!(part.columns[0].primary_key && part.columns[1].primary_key);
    assert!(!part.columns[2].primary_key);

    // kinds_and_quoted_names
    let tables = describe(&[oids["users_v"], oids["users_mv"], oids["Order Items"]]).await;
    assert_eq!(table(&tables, oids["users_v"]).kind, RelationKind::View);
    assert_eq!(
        table(&tables, oids["users_mv"]).kind,
        RelationKind::MaterializedView
    );
    let items = table(&tables, oids["Order Items"]);
    assert_eq!(items.qualified_name, "m10_edit.\"Order Items\"");
    assert_eq!(items.name, "Order Items");
    assert_eq!(items.columns[1].name, "Note");
    assert_eq!(items.columns[1].quoted_name, "\"Note\"");
    assert_eq!(items.columns[0].quoted_name, "id");

    // unknown_oids_are_left_out: 인덱스(`users_pkey`)와 없는 OID는 빠진다.
    let index = admin()
        .await
        .query_one("SELECT 'm10_edit.users_pkey'::regclass::oid", &[])
        .await
        .unwrap()
        .get::<_, u32>(0);
    let tables = describe(&[4_000_000_000, index, oids["orders"], 0]).await;
    assert_eq!(
        tables.iter().map(|t| t.oid).collect::<Vec<_>>(),
        vec![oids["orders"]]
    );
    assert_eq!(describe(&[]).await, vec![]);

    // table_without_primary_key
    let tables = describe(&[oids["nopk"]]).await;
    let nopk = table(&tables, oids["nopk"]);
    assert_eq!(nopk.columns.len(), 2);
    assert!(nopk.columns.iter().all(|c| !c.primary_key && c.updatable));

    drop_edit_schema().await;
}
