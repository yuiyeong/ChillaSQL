//! relation 하나의 DDL을 실제 catalog(test DB)에서 읽어 조립한다.
//! test DB는 `scripts/test-db.sh up`으로 띄운다. test마다 schema를 따로 만들고 끝에 지운다.

mod support;

use chilla_core::application::DbConnection;
use chilla_core::domain::render_ddl;
use chilla_core::infrastructure::PgConnection;
use support::{admin, connect};

/// 만든 schema들. test가 실패해도 drop할 때 지운다. 시작할 때도 지우므로 지난 실행이 남긴 것이
/// 있어도 된다.
struct Schemas(&'static [&'static str]);

impl Schemas {
    /// schema들을 새로 만들고 `sql`을 실행한다.
    async fn create(names: &'static [&'static str], sql: &str) -> Self {
        let schemas = Self(names);
        let create: String = names
            .iter()
            .map(|name| format!("CREATE SCHEMA {name};"))
            .collect();
        admin()
            .await
            .batch_execute(&format!("{}{create}{sql}", schemas.drop_sql()))
            .await
            .unwrap();
        schemas
    }

    fn drop_sql(&self) -> String {
        self.0
            .iter()
            .map(|name| format!("DROP SCHEMA IF EXISTS {name} CASCADE;"))
            .collect()
    }
}

impl Drop for Schemas {
    /// test의 runtime은 이미 멈추는 중일 수 있어 따로 띄운 thread와 runtime에서 지운다.
    fn drop(&mut self) {
        let sql = self.drop_sql();
        let _ = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async { admin().await.batch_execute(&sql).await })
        })
        .join();
    }
}

async fn oid(name: &str) -> u32 {
    admin()
        .await
        .query_one("SELECT $1::text::regclass::oid", &[&name])
        .await
        .unwrap()
        .get(0)
}

async fn ddl_of(db: &PgConnection, name: &str) -> String {
    let ddl = db.read_ddl(oid(name).await).await.unwrap();
    render_ddl(&ddl.unwrap_or_else(|| panic!("{name}의 DDL이 없다")))
}

const SOURCE: &str = r#"
    CREATE FUNCTION ddl_src.touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
    CREATE FUNCTION ddl_dst.touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
    CREATE TABLE ddl_src.parent (id int PRIMARY KEY);
    CREATE TABLE ddl_src.items (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        code text COLLATE "C" NOT NULL,
        qty int NOT NULL DEFAULT 1 CHECK (qty > 0),
        doubled int GENERATED ALWAYS AS (qty * 2) STORED,
        lowered text GENERATED ALWAYS AS (lower(code)) VIRTUAL,
        parent_id int REFERENCES ddl_src.parent,
        during int4range,
        note text,
        UNIQUE (code),
        EXCLUDE USING gist (during WITH &&)
    ) WITH (fillfactor = 70);
    CREATE INDEX items_note ON ddl_src.items (lower(note)) WHERE note IS NOT NULL;
    CREATE TRIGGER items_touch BEFORE UPDATE ON ddl_src.items
        FOR EACH ROW EXECUTE FUNCTION ddl_src.touch();
    COMMENT ON TABLE ddl_src.items IS 'it''s items';
    COMMENT ON COLUMN ddl_src.items.note IS 'free text';
    CREATE TABLE ddl_src.events (id int, at date NOT NULL, note text, PRIMARY KEY (id, at))
        PARTITION BY RANGE (at);
    CREATE INDEX events_note ON ddl_src.events (note);
    CREATE TRIGGER events_touch BEFORE UPDATE ON ddl_src.events
        FOR EACH ROW EXECUTE FUNCTION ddl_src.touch();
    CREATE TABLE ddl_src.events_2026 PARTITION OF ddl_src.events
        FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
    CREATE TABLE ddl_src.child (extra text NOT NULL) INHERITS (ddl_src.parent);
    CREATE UNLOGGED TABLE ddl_src.scratch (k text);
    CREATE VIEW ddl_src.v_items AS SELECT id, code FROM ddl_src.items WHERE qty > 1;
    COMMENT ON VIEW ddl_src.v_items IS 'view';
    CREATE MATERIALIZED VIEW ddl_src.mv_items AS SELECT id FROM ddl_src.items;
    CREATE INDEX mv_items_id ON ddl_src.mv_items (id);
"#;

/// 만든 순서. 앞의 것이 뒤의 것의 부모나 참조 대상이다.
const RELATIONS: [&str; 8] = [
    "parent",
    "items",
    "events",
    "events_2026",
    "child",
    "scratch",
    "v_items",
    "mv_items",
];

/// `ddl_src`에서 읽은 DDL을 `ddl_dst`에서 실행하고 다시 읽으면 schema 이름 말고는 같다.
#[tokio::test]
async fn ddl_round_trips() {
    let _schemas = Schemas::create(&["ddl_src", "ddl_dst"], SOURCE).await;
    let db = connect().await;
    let admin = admin().await;

    for name in RELATIONS {
        let source = ddl_of(&db, &format!("ddl_src.{name}")).await;
        admin
            .batch_execute(&source.replace("ddl_src.", "ddl_dst."))
            .await
            .unwrap_or_else(|e| panic!("{name}: {e}\n{source}"));
        let copy = ddl_of(&db, &format!("ddl_dst.{name}")).await;
        assert_eq!(copy.replace("ddl_dst.", "ddl_src."), source, "{name}");
    }

    assert_eq!(
        ddl_of(&db, "ddl_src.items").await,
        r#"CREATE TABLE ddl_src.items (
  id        bigint GENERATED ALWAYS AS IDENTITY,
  code      text COLLATE "C" NOT NULL,
  qty       integer NOT NULL DEFAULT 1,
  doubled   integer GENERATED ALWAYS AS ((qty * 2)) STORED,
  lowered   text GENERATED ALWAYS AS (lower(code)) VIRTUAL,
  parent_id integer,
  during    int4range,
  note      text,
  CONSTRAINT items_pkey PRIMARY KEY (id),
  CONSTRAINT items_code_key UNIQUE (code),
  CONSTRAINT items_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES ddl_src.parent(id),
  CONSTRAINT items_qty_check CHECK ((qty > 0)),
  CONSTRAINT items_during_excl EXCLUDE USING gist (during WITH &&)
) WITH (fillfactor=70);
CREATE INDEX items_note ON ddl_src.items USING btree (lower(note)) WHERE (note IS NOT NULL);
CREATE TRIGGER items_touch BEFORE UPDATE ON ddl_src.items FOR EACH ROW EXECUTE FUNCTION ddl_src.touch();
COMMENT ON TABLE ddl_src.items IS 'it''s items';
COMMENT ON COLUMN ddl_src.items.note IS 'free text';"#
    );
    // partitioned table의 인덱스는 partition에도 만들어지게 `ON ONLY` 없이 쓴다.
    assert_eq!(
        ddl_of(&db, "ddl_src.events").await,
        "CREATE TABLE ddl_src.events (\n\
         \x20 id   integer,\n\
         \x20 at   date,\n\
         \x20 note text,\n\
         \x20 CONSTRAINT events_pkey PRIMARY KEY (id, at)\n\
         ) PARTITION BY RANGE (at);\n\
         CREATE INDEX events_note ON ddl_src.events USING btree (note);\n\
         CREATE TRIGGER events_touch BEFORE UPDATE ON ddl_src.events FOR EACH ROW EXECUTE FUNCTION ddl_src.touch();"
    );
    // 부모에게서 받은 컬럼, 제약조건, 인덱스, trigger는 쓰지 않는다.
    assert_eq!(
        ddl_of(&db, "ddl_src.events_2026").await,
        "CREATE TABLE ddl_src.events_2026 PARTITION OF ddl_src.events\n\
         \x20 FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');"
    );
    assert_eq!(
        ddl_of(&db, "ddl_src.child").await,
        "CREATE TABLE ddl_src.child (\n\
         \x20 extra text NOT NULL\n\
         ) INHERITS (ddl_src.parent);"
    );
    assert_eq!(
        ddl_of(&db, "ddl_src.scratch").await,
        "CREATE UNLOGGED TABLE ddl_src.scratch (\n\x20 k text\n);"
    );
    assert_eq!(
        ddl_of(&db, "ddl_src.v_items").await,
        "CREATE VIEW ddl_src.v_items AS\n\
         SELECT id,\n    code\n   FROM ddl_src.items\n  WHERE qty > 1;\n\
         COMMENT ON VIEW ddl_src.v_items IS 'view';"
    );
    assert_eq!(
        ddl_of(&db, "ddl_src.mv_items").await,
        "CREATE MATERIALIZED VIEW ddl_src.mv_items AS\n\
         SELECT id\n   FROM ddl_src.items;\n\
         CREATE INDEX mv_items_id ON ddl_src.mv_items USING btree (id);"
    );
}

/// PostgreSQL 18은 NOT NULL을 `_not_null` 제약(contype `n`)으로도 둔다. 컬럼에만 한 번 쓴다.
#[tokio::test]
async fn postgres_18_not_null_appears_once() {
    let _schemas = Schemas::create(
        &["ddl_not_null"],
        "CREATE TABLE ddl_not_null.t (id int PRIMARY KEY, email text NOT NULL, note text);",
    )
    .await;
    let db = connect().await;

    let ddl = ddl_of(&db, "ddl_not_null.t").await;

    assert_eq!(ddl.matches("NOT NULL").count(), 1, "{ddl}");
    assert!(ddl.contains("  email text NOT NULL,\n"), "{ddl}");
    assert!(!ddl.contains("_not_null "), "{ddl}");
}

#[tokio::test]
async fn unknown_oid_is_none() {
    let db = connect().await;
    assert_eq!(db.read_ddl(0).await.unwrap(), None);
    // 인덱스처럼 DDL을 보이지 않는 relation도 없다.
    let index = oid("pg_catalog.pg_class_oid_index").await;
    assert_eq!(db.read_ddl(index).await.unwrap(), None);
}

#[tokio::test]
async fn quoted_names() {
    let _schemas = Schemas::create(
        &["ddl_names"],
        r#"
        CREATE TABLE ddl_names."Order Items" (id int PRIMARY KEY, "수량" int NOT NULL);
        COMMENT ON COLUMN ddl_names."Order Items"."수량" IS '개수';
        "#,
    )
    .await;
    let db = connect().await;

    assert_eq!(
        ddl_of(&db, r#"ddl_names."Order Items""#).await,
        r#"CREATE TABLE ddl_names."Order Items" (
  id     integer,
  "수량" integer NOT NULL,
  CONSTRAINT "Order Items_pkey" PRIMARY KEY (id)
);
COMMENT ON COLUMN ddl_names."Order Items"."수량" IS '개수';"#
    );
}
