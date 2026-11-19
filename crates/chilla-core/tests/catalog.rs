//! 스키마 트리와 자동완성의 catalog SQL을 실제 구성(test DB)으로 검사한다.
//! test DB는 `scripts/test-db.sh up`으로 띄운다. test마다 `m7_cat_` 이름의 schema를 따로 쓴다.

mod support;

use chilla_core::application::DbConnection;
use chilla_core::domain::{
    CatalogColumn, ConstraintKind, FunctionName, Relation, RelationKind, TableDetails,
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
