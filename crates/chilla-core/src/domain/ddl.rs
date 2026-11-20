//! 테이블과 view의 생성문(DDL). catalog에서 읽은 재료를 text로 조립한다.

use super::RelationKind;

/// relation 하나의 DDL 재료. 이름과 식은 모두 서버가 만든 text다(`quote_ident`, `format_type`,
/// `pg_get_*`, `quote_literal`). 그대로 이어 붙이면 실행할 수 있다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationDdl {
    /// schema를 붙인 이름(`public.users`).
    pub name: String,
    pub kind: RelationKind,
    pub unlogged: bool,
    /// 이 relation이 정의한 컬럼, 정의 순서. partition과 view면 비어 있다.
    pub columns: Vec<DdlColumn>,
    /// 이 relation이 정의한 제약조건. primary key, unique, foreign key, check, exclusion 순이고
    /// 그 안에서 이름 순이다.
    pub constraints: Vec<DdlConstraint>,
    /// `INHERITS`의 부모, 상속 순서.
    pub inherits: Vec<String>,
    pub partition_of: Option<PartitionOf>,
    /// `pg_get_partkeydef`(`RANGE (created_at)`).
    pub partition_by: Option<String>,
    /// `reloptions`의 항목(`fillfactor=70`).
    pub options: Vec<String>,
    /// `pg_get_viewdef(oid, true)`. view와 materialized view에만 있다.
    pub view_definition: Option<String>,
    /// 제약조건이 만들지 않은 인덱스의 `pg_get_indexdef`, 이름 순.
    pub indexes: Vec<String>,
    /// 내부가 아닌 trigger의 `pg_get_triggerdef`, 이름 순.
    pub triggers: Vec<String>,
    /// `quote_literal` 된 테이블 comment.
    pub comment: Option<String>,
    /// (`quote_ident` 된 컬럼, `quote_literal` 된 comment), 컬럼 순.
    pub column_comments: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DdlColumn {
    pub name: String,
    /// `format_type`이 만든 이름.
    pub type_name: String,
    /// type의 기본과 다를 때만 있다.
    pub collation: Option<String>,
    pub not_null: bool,
    /// primary key에 든 컬럼이다. NOT NULL을 따로 쓰지 않는다.
    pub primary_key: bool,
    /// `pg_get_expr(adbin)`. generated 컬럼이면 `None`이다(식은 `generated`에 있다).
    pub default: Option<String>,
    pub identity: Option<Identity>,
    pub generated: Option<Generated>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Identity {
    Always,
    ByDefault,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generated {
    pub expression: String,
    /// `STORED`면 true, `VIRTUAL`(PostgreSQL 18)이면 false다.
    pub stored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DdlConstraint {
    /// `quote_ident` 된 이름.
    pub name: String,
    /// `pg_get_constraintdef`.
    pub definition: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartitionOf {
    /// schema를 붙인 부모 이름.
    pub parent: String,
    /// `pg_get_expr(relpartbound)`(`FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`, `DEFAULT`).
    pub bound: String,
}

/// 생성문, 인덱스, trigger, comment를 한 줄씩(생성문은 여러 줄) `;`로 끝내 이어 붙인다.
/// 마지막 문장 뒤에는 줄바꿈이 없다.
pub fn render_ddl(ddl: &RelationDdl) -> String {
    let mut statements = vec![create_statement(ddl)];
    statements.extend(ddl.indexes.iter().map(|index| format!("{index};")));
    statements.extend(ddl.triggers.iter().map(|trigger| format!("{trigger};")));
    if let Some(comment) = &ddl.comment {
        statements.push(format!(
            "COMMENT ON {} {} IS {comment};",
            object_type(ddl.kind),
            ddl.name
        ));
    }
    statements.extend(
        ddl.column_comments.iter().map(|(column, comment)| {
            format!("COMMENT ON COLUMN {}.{column} IS {comment};", ddl.name)
        }),
    );
    statements.join("\n")
}

/// `COMMENT ON` 뒤에 쓰는 종류. view에 `TABLE`을 쓰면 서버가 거절한다.
fn object_type(kind: RelationKind) -> &'static str {
    match kind {
        RelationKind::Table | RelationKind::PartitionedTable => "TABLE",
        RelationKind::ForeignTable => "FOREIGN TABLE",
        RelationKind::View => "VIEW",
        RelationKind::MaterializedView => "MATERIALIZED VIEW",
    }
}

fn create_statement(ddl: &RelationDdl) -> String {
    let with = match ddl.options.is_empty() {
        true => String::new(),
        false => format!(" WITH ({})", ddl.options.join(", ")),
    };
    let view = match ddl.kind {
        RelationKind::View => Some("VIEW"),
        RelationKind::MaterializedView => Some("MATERIALIZED VIEW"),
        _ => None,
    };
    if let Some(view) = view {
        // `pg_get_viewdef`는 앞에 공백을 두고 `;`로 끝난다.
        let definition = ddl.view_definition.as_deref().unwrap_or_default().trim();
        let end = if definition.ends_with(';') { "" } else { ";" };
        return format!("CREATE {view} {}{with} AS\n{definition}{end}", ddl.name);
    }

    let unlogged = if ddl.unlogged { "UNLOGGED " } else { "" };
    let mut sql = format!("CREATE {unlogged}TABLE {}", ddl.name);
    let body = body_lines(ddl);
    if let Some(partition) = &ddl.partition_of {
        sql.push_str(&format!(" PARTITION OF {}", partition.parent));
        if !body.is_empty() {
            sql.push_str(&format!(" (\n{}\n)", body.join(",\n")));
        }
        sql.push_str(&format!("\n  {}", partition.bound));
    } else if body.is_empty() {
        sql.push_str(" ()");
    } else {
        sql.push_str(&format!(" (\n{}\n)", body.join(",\n")));
    }
    if !ddl.inherits.is_empty() {
        sql.push_str(&format!(" INHERITS ({})", ddl.inherits.join(", ")));
    }
    if let Some(key) = &ddl.partition_by {
        sql.push_str(&format!(" PARTITION BY {key}"));
    }
    sql.push_str(&with);
    sql.push(';');
    sql
}

/// 괄호 안의 줄: 컬럼(이름을 가장 긴 이름 + 1칸에 맞춤) 다음 제약조건. 들여쓰기는 2칸이다.
fn body_lines(ddl: &RelationDdl) -> Vec<String> {
    let width = ddl
        .columns
        .iter()
        .map(|column| display_width(&column.name))
        .max()
        .unwrap_or(0)
        + 1;
    let columns = ddl.columns.iter().map(|column| {
        let pad = " ".repeat(width - display_width(&column.name));
        format!("  {}{pad}{}", column.name, column_definition(column))
    });
    let constraints = ddl
        .constraints
        .iter()
        .map(|c| format!("  CONSTRAINT {} {}", c.name, c.definition));
    columns.chain(constraints).collect()
}

/// mono 글꼴에서 차지하는 칸 수. 한글과 CJK 글자는 두 칸이다(D2Coding).
fn display_width(text: &str) -> usize {
    text.chars().map(|c| if is_wide(c) { 2 } else { 1 }).sum()
}

/// Unicode East Asian Width가 Wide나 Fullwidth인 주요 범위.
fn is_wide(c: char) -> bool {
    matches!(
        c,
        '\u{1100}'..='\u{115F}'
            | '\u{2E80}'..='\u{303E}'
            | '\u{3041}'..='\u{33FF}'
            | '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{A000}'..='\u{A4CF}'
            | '\u{A960}'..='\u{A97F}'
            | '\u{AC00}'..='\u{D7A3}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{FE30}'..='\u{FE4F}'
            | '\u{FF00}'..='\u{FF60}'
            | '\u{FFE0}'..='\u{FFE6}'
            | '\u{20000}'..='\u{3FFFD}'
    )
}

/// type 뒤의 부분. identity와 primary key 컬럼은 NOT NULL이 저절로 붙으므로 쓰지 않는다.
fn column_definition(column: &DdlColumn) -> String {
    let mut parts = vec![column.type_name.clone()];
    if let Some(collation) = &column.collation {
        parts.push(format!("COLLATE {collation}"));
    }
    match column.identity {
        Some(Identity::Always) => parts.push("GENERATED ALWAYS AS IDENTITY".into()),
        Some(Identity::ByDefault) => parts.push("GENERATED BY DEFAULT AS IDENTITY".into()),
        None => {}
    }
    if let Some(generated) = &column.generated {
        let kind = if generated.stored {
            "STORED"
        } else {
            "VIRTUAL"
        };
        parts.push(format!(
            "GENERATED ALWAYS AS ({}) {kind}",
            generated.expression
        ));
    }
    if column.not_null && !column.primary_key && column.identity.is_none() {
        parts.push("NOT NULL".into());
    }
    if let Some(default) = &column.default {
        parts.push(format!("DEFAULT {default}"));
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(name: &str) -> RelationDdl {
        RelationDdl {
            name: name.into(),
            kind: RelationKind::Table,
            unlogged: false,
            columns: vec![],
            constraints: vec![],
            inherits: vec![],
            partition_of: None,
            partition_by: None,
            options: vec![],
            view_definition: None,
            indexes: vec![],
            triggers: vec![],
            comment: None,
            column_comments: vec![],
        }
    }

    fn column(name: &str, type_name: &str) -> DdlColumn {
        DdlColumn {
            name: name.into(),
            type_name: type_name.into(),
            collation: None,
            not_null: false,
            primary_key: false,
            default: None,
            identity: None,
            generated: None,
        }
    }

    fn constraint(name: &str, definition: &str) -> DdlConstraint {
        DdlConstraint {
            name: name.into(),
            definition: definition.into(),
        }
    }

    /// Tools M9 "DDL 보기"의 예시.
    #[test]
    fn renders_the_design_example() {
        let ddl = RelationDdl {
            columns: vec![
                DdlColumn {
                    not_null: true,
                    primary_key: true,
                    identity: Some(Identity::Always),
                    ..column("id", "bigint")
                },
                DdlColumn {
                    not_null: true,
                    ..column("email", "text")
                },
                column("display_name", "text"),
                DdlColumn {
                    not_null: true,
                    default: Some("now()".into()),
                    ..column("created_at", "timestamptz")
                },
                column("profile", "jsonb"),
            ],
            constraints: vec![constraint("users_pkey", "PRIMARY KEY (id)")],
            indexes: vec!["CREATE UNIQUE INDEX users_email_key ON public.users (email)".into()],
            ..table("public.users")
        };

        assert_eq!(
            render_ddl(&ddl),
            "CREATE TABLE public.users (\n\
             \x20 id           bigint GENERATED ALWAYS AS IDENTITY,\n\
             \x20 email        text NOT NULL,\n\
             \x20 display_name text,\n\
             \x20 created_at   timestamptz NOT NULL DEFAULT now(),\n\
             \x20 profile      jsonb,\n\
             \x20 CONSTRAINT users_pkey PRIMARY KEY (id)\n\
             );\n\
             CREATE UNIQUE INDEX users_email_key ON public.users (email);"
        );
    }

    #[test]
    fn primary_key_column_without_identity_has_no_not_null() {
        let ddl = RelationDdl {
            columns: vec![
                DdlColumn {
                    not_null: true,
                    primary_key: true,
                    ..column("id", "integer")
                },
                DdlColumn {
                    collation: Some("\"C\"".into()),
                    identity: Some(Identity::ByDefault),
                    not_null: true,
                    ..column("code", "text")
                },
            ],
            ..table("s.t")
        };

        assert_eq!(
            render_ddl(&ddl),
            "CREATE TABLE s.t (\n\
             \x20 id   integer,\n\
             \x20 code text COLLATE \"C\" GENERATED BY DEFAULT AS IDENTITY\n\
             );"
        );
    }

    #[test]
    fn partition_renders_partition_of() {
        let ddl = RelationDdl {
            partition_of: Some(PartitionOf {
                parent: "public.events".into(),
                bound: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')".into(),
            }),
            ..table("public.events_2026")
        };

        assert_eq!(
            render_ddl(&ddl),
            "CREATE TABLE public.events_2026 PARTITION OF public.events\n\
             \x20 FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');"
        );
    }

    /// partition이 따로 정한 제약조건은 괄호 안에 쓴다. 부모에게서 받은 것은 읽을 때 빠진다.
    #[test]
    fn partition_with_its_own_constraint_and_sub_partitions() {
        let ddl = RelationDdl {
            constraints: vec![constraint("p_n_check", "CHECK ((n > 0))")],
            partition_of: Some(PartitionOf {
                parent: "s.parent".into(),
                bound: "DEFAULT".into(),
            }),
            partition_by: Some("LIST (n)".into()),
            kind: RelationKind::PartitionedTable,
            ..table("s.p")
        };

        assert_eq!(
            render_ddl(&ddl),
            "CREATE TABLE s.p PARTITION OF s.parent (\n\
             \x20 CONSTRAINT p_n_check CHECK ((n > 0))\n\
             )\n\
             \x20 DEFAULT PARTITION BY LIST (n);"
        );
    }

    #[test]
    fn partitioned_table_renders_partition_by() {
        let ddl = RelationDdl {
            kind: RelationKind::PartitionedTable,
            columns: vec![column("id", "integer"), column("at", "date")],
            partition_by: Some("RANGE (at)".into()),
            indexes: vec!["CREATE INDEX events_at ON public.events USING btree (at)".into()],
            ..table("public.events")
        };

        assert_eq!(
            render_ddl(&ddl),
            "CREATE TABLE public.events (\n\
             \x20 id integer,\n\
             \x20 at date\n\
             ) PARTITION BY RANGE (at);\n\
             CREATE INDEX events_at ON public.events USING btree (at);"
        );
    }

    #[test]
    fn unlogged_inherits_and_options() {
        let ddl = RelationDdl {
            unlogged: true,
            columns: vec![DdlColumn {
                not_null: true,
                ..column("extra", "text")
            }],
            inherits: vec!["s.a".into(), "s.b".into()],
            options: vec!["fillfactor=70".into(), "autovacuum_enabled=false".into()],
            ..table("s.child")
        };

        assert_eq!(
            render_ddl(&ddl),
            "CREATE UNLOGGED TABLE s.child (\n\
             \x20 extra text NOT NULL\n\
             ) INHERITS (s.a, s.b) WITH (fillfactor=70, autovacuum_enabled=false);"
        );
    }

    #[test]
    fn table_without_columns() {
        assert_eq!(render_ddl(&table("s.empty")), "CREATE TABLE s.empty ();");
    }

    #[test]
    fn generated_virtual_and_stored() {
        let ddl = RelationDdl {
            columns: vec![
                column("n", "integer"),
                DdlColumn {
                    generated: Some(Generated {
                        expression: "(n * 2)".into(),
                        stored: true,
                    }),
                    ..column("doubled", "integer")
                },
                DdlColumn {
                    generated: Some(Generated {
                        expression: "lower(code)".into(),
                        stored: false,
                    }),
                    not_null: true,
                    ..column("lowered", "text")
                },
            ],
            ..table("s.g")
        };

        assert_eq!(
            render_ddl(&ddl),
            "CREATE TABLE s.g (\n\
             \x20 n       integer,\n\
             \x20 doubled integer GENERATED ALWAYS AS ((n * 2)) STORED,\n\
             \x20 lowered text GENERATED ALWAYS AS (lower(code)) VIRTUAL NOT NULL\n\
             );"
        );
    }

    #[test]
    fn view_and_materialized_view() {
        let view = RelationDdl {
            kind: RelationKind::View,
            view_definition: Some(" SELECT id,\n    code\n   FROM s.items;".into()),
            triggers: vec![
                "CREATE TRIGGER v_ins INSTEAD OF INSERT ON s.v FOR EACH ROW EXECUTE FUNCTION s.f()"
                    .into(),
            ],
            ..table("s.v")
        };
        assert_eq!(
            render_ddl(&view),
            "CREATE VIEW s.v AS\n\
             SELECT id,\n    code\n   FROM s.items;\n\
             CREATE TRIGGER v_ins INSTEAD OF INSERT ON s.v FOR EACH ROW EXECUTE FUNCTION s.f();"
        );

        let materialized = RelationDdl {
            kind: RelationKind::MaterializedView,
            view_definition: Some(" SELECT id\n   FROM s.items;".into()),
            indexes: vec!["CREATE INDEX mv_id ON s.mv USING btree (id)".into()],
            ..table("s.mv")
        };
        assert_eq!(
            render_ddl(&materialized),
            "CREATE MATERIALIZED VIEW s.mv AS\n\
             SELECT id\n   FROM s.items;\n\
             CREATE INDEX mv_id ON s.mv USING btree (id);"
        );

        let with_options = RelationDdl {
            kind: RelationKind::View,
            options: vec!["check_option=local".into()],
            view_definition: Some(" SELECT 1;".into()),
            ..table("s.w")
        };
        assert_eq!(
            render_ddl(&with_options),
            "CREATE VIEW s.w WITH (check_option=local) AS\nSELECT 1;"
        );
    }

    #[test]
    fn comments_come_last() {
        let ddl = RelationDdl {
            columns: vec![column("note", "text"), column("\"수량\"", "integer")],
            indexes: vec!["CREATE INDEX t_note ON s.t USING btree (note)".into()],
            triggers: vec![
                "CREATE TRIGGER t_touch BEFORE UPDATE ON s.t FOR EACH ROW EXECUTE FUNCTION s.f()"
                    .into(),
            ],
            comment: Some("'it''s t'".into()),
            column_comments: vec![
                ("note".into(), "E'a\\\\b'".into()),
                ("\"수량\"".into(), "'qty'".into()),
            ],
            ..table("s.t")
        };

        assert_eq!(
            render_ddl(&ddl),
            "CREATE TABLE s.t (\n\
             \x20 note   text,\n\
             \x20 \"수량\" integer\n\
             );\n\
             CREATE INDEX t_note ON s.t USING btree (note);\n\
             CREATE TRIGGER t_touch BEFORE UPDATE ON s.t FOR EACH ROW EXECUTE FUNCTION s.f();\n\
             COMMENT ON TABLE s.t IS 'it''s t';\n\
             COMMENT ON COLUMN s.t.note IS E'a\\\\b';\n\
             COMMENT ON COLUMN s.t.\"수량\" IS 'qty';"
        );
    }

    /// 한글 이름은 글자마다 두 칸을 차지한다. 이름 뒤 칸을 그만큼 덜 채워 type의 열을 맞춘다.
    #[test]
    fn wide_names_align_by_display_width() {
        let ddl = RelationDdl {
            columns: vec![column("\"수량\"", "integer"), column("id", "integer")],
            ..table("s.t")
        };
        assert_eq!(
            render_ddl(&ddl),
            "CREATE TABLE s.t (\n\
             \x20 \"수량\" integer,\n\
             \x20 id     integer\n\
             );"
        );
    }

    #[test]
    fn view_comments_name_the_kind() {
        let view = RelationDdl {
            kind: RelationKind::View,
            view_definition: Some(" SELECT 1 AS one;".into()),
            comment: Some("'v'".into()),
            ..table("s.v")
        };
        assert!(render_ddl(&view).ends_with("\nCOMMENT ON VIEW s.v IS 'v';"));

        let materialized = RelationDdl {
            kind: RelationKind::MaterializedView,
            ..view.clone()
        };
        assert!(render_ddl(&materialized).ends_with("\nCOMMENT ON MATERIALIZED VIEW s.v IS 'v';"));
    }
}
