use pg_query::protobuf::{
    DropStmt, ObjectType, RangeVar, RoleSpec, RoleSpecType, SelectStmt, WithClause,
};
use pg_query::{Node, NodeEnum};

use crate::application::StatementInspector;
use crate::domain::Danger;

/// `pg_query::parse`의 syntax tree로 위험한 문장을 찾는다.
///
/// 읽는 것은 `UPDATE`, `DELETE`, `DROP`(`DROP ROLE`, `DROP OWNED`, `DROP TABLESPACE` 포함), `TRUNCATE`와
/// 그것들이 숨은 자리(CTE, `EXPLAIN ANALYZE`)다.
/// `DO` block, 함수 본문, `ALTER TABLE … DROP COLUMN`은 보지 않는다.
pub struct PgQueryInspector;

impl StatementInspector for PgQueryInspector {
    fn danger(&self, sql: &str) -> Option<Danger> {
        let parsed = pg_query::parse(sql, pg_query::ParserOptions::DEFAULT).ok()?;
        parsed
            .protobuf
            .stmts
            .iter()
            .find_map(|raw| node_danger(raw.stmt.as_deref()?))
    }
}

fn node_danger(node: &Node) -> Option<Danger> {
    match node.node.as_ref()? {
        NodeEnum::UpdateStmt(stmt) => without_where(
            stmt.with_clause.as_ref(),
            stmt.relation.as_ref(),
            stmt.where_clause.is_some(),
            |table| Danger::UpdateWithoutWhere { table },
        ),
        NodeEnum::DeleteStmt(stmt) => without_where(
            stmt.with_clause.as_ref(),
            stmt.relation.as_ref(),
            stmt.where_clause.is_some(),
            |table| Danger::DeleteWithoutWhere { table },
        ),
        NodeEnum::InsertStmt(stmt) => with_danger(stmt.with_clause.as_ref())
            .or_else(|| node_danger(stmt.select_stmt.as_deref()?)),
        NodeEnum::SelectStmt(stmt) => select_danger(stmt),
        NodeEnum::ExplainStmt(stmt) => {
            // ANALYZE가 없으면 EXPLAIN은 안쪽 문장을 실행하지 않는다.
            if stmt.options.iter().any(analyze_is_on) {
                node_danger(stmt.query.as_deref()?)
            } else {
                None
            }
        }
        NodeEnum::DropStmt(stmt) => Some(drop_danger(stmt)),
        NodeEnum::DropdbStmt(stmt) => Some(Danger::Drop {
            kind: "DATABASE".into(),
            names: vec![stmt.dbname.clone()],
        }),
        // `DROP USER`와 `DROP GROUP`도 같은 문장이고 tree에서 구분되지 않는다.
        NodeEnum::DropRoleStmt(stmt) => Some(Danger::Drop {
            kind: "ROLE".into(),
            names: stmt.roles.iter().filter_map(role_name).collect(),
        }),
        // role이 아니라 role이 가진 object를 지운다. `names`는 그 role이다.
        NodeEnum::DropOwnedStmt(stmt) => Some(Danger::Drop {
            kind: "OWNED".into(),
            names: stmt.roles.iter().filter_map(role_name).collect(),
        }),
        NodeEnum::DropTableSpaceStmt(stmt) => Some(Danger::Drop {
            kind: "TABLESPACE".into(),
            names: vec![stmt.tablespacename.clone()],
        }),
        NodeEnum::TruncateStmt(stmt) => Some(Danger::Truncate {
            tables: stmt.relations.iter().filter_map(object_name).collect(),
        }),
        _ => None,
    }
}

/// `UPDATE`와 `DELETE`는 CTE를 먼저 보고, 그다음 `WHERE`가 없는지 본다.
fn without_where(
    with: Option<&WithClause>,
    relation: Option<&RangeVar>,
    has_where: bool,
    danger: fn(String) -> Danger,
) -> Option<Danger> {
    with_danger(with).or_else(|| {
        let table = relation?;
        (!has_where).then(|| danger(range_var_name(table)))
    })
}

/// `SELECT`의 `larg`와 `rarg`는 `Node`가 아니라 `SelectStmt`로 바로 들어 있다.
fn select_danger(stmt: &SelectStmt) -> Option<Danger> {
    with_danger(stmt.with_clause.as_ref())
        .or_else(|| select_danger(stmt.larg.as_deref()?))
        .or_else(|| select_danger(stmt.rarg.as_deref()?))
}

/// CTE를 적힌 순서대로 본다.
fn with_danger(with: Option<&WithClause>) -> Option<Danger> {
    with?.ctes.iter().find_map(|cte| match cte.node.as_ref()? {
        NodeEnum::CommonTableExpr(cte) => node_danger(cte.ctequery.as_deref()?),
        _ => None,
    })
}

fn drop_danger(stmt: &DropStmt) -> Danger {
    let kind = match ObjectType::try_from(stmt.remove_type) {
        Ok(ObjectType::ObjectTable) => "TABLE",
        Ok(ObjectType::ObjectView) => "VIEW",
        Ok(ObjectType::ObjectMatview) => "MATERIALIZED VIEW",
        Ok(ObjectType::ObjectIndex) => "INDEX",
        Ok(ObjectType::ObjectSchema) => "SCHEMA",
        Ok(ObjectType::ObjectSequence) => "SEQUENCE",
        Ok(ObjectType::ObjectFunction) => "FUNCTION",
        Ok(ObjectType::ObjectType) => "TYPE",
        Ok(ObjectType::ObjectExtension) => "EXTENSION",
        Ok(ObjectType::ObjectDatabase) => "DATABASE",
        _ => "",
    };
    Danger::Drop {
        kind: kind.into(),
        names: stmt.objects.iter().filter_map(object_name).collect(),
    }
}

/// `schema.table`처럼 문장에 쓴 대로 이름을 만든다. parser가 따옴표를 이미 벗겼다.
fn object_name(node: &Node) -> Option<String> {
    match node.node.as_ref()? {
        NodeEnum::RangeVar(var) => Some(range_var_name(var)),
        // `DROP TABLE a.b`의 object는 이름 조각의 list다.
        NodeEnum::List(list) => Some(join_names(&list.items)),
        // `DROP SCHEMA s`의 object는 String 하나다.
        NodeEnum::String(name) => Some(name.sval.clone()),
        NodeEnum::TypeName(name) => Some(join_names(&name.names)),
        NodeEnum::ObjectWithArgs(function) => Some(join_names(&function.objname)),
        _ => None,
    }
}

/// 이름이 없는 role(`CURRENT_USER` 등)은 그 keyword로 쓴다.
fn role_name(node: &Node) -> Option<String> {
    let NodeEnum::RoleSpec(RoleSpec {
        roletype, rolename, ..
    }) = node.node.as_ref()?
    else {
        return None;
    };
    let name = match RoleSpecType::try_from(*roletype) {
        Ok(RoleSpecType::RolespecCurrentRole) => "CURRENT_ROLE",
        Ok(RoleSpecType::RolespecCurrentUser) => "CURRENT_USER",
        Ok(RoleSpecType::RolespecSessionUser) => "SESSION_USER",
        Ok(RoleSpecType::RolespecPublic) => "PUBLIC",
        _ => rolename,
    };
    Some(name.to_string())
}

fn join_names(parts: &[Node]) -> String {
    let names: Vec<&str> = parts
        .iter()
        .filter_map(|part| match part.node.as_ref()? {
            NodeEnum::String(name) => Some(name.sval.as_str()),
            _ => None,
        })
        .collect();
    names.join(".")
}

fn range_var_name(var: &RangeVar) -> String {
    [&var.catalogname, &var.schemaname, &var.relname]
        .into_iter()
        .filter(|part| !part.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(".")
}

/// `EXPLAIN (ANALYZE)`는 값이 없고, `ANALYZE true|on|1`은 문자열이나 정수로 온다.
fn analyze_is_on(option: &Node) -> bool {
    let Some(NodeEnum::DefElem(option)) = option.node.as_ref() else {
        return false;
    };
    if !option.defname.eq_ignore_ascii_case("analyze") {
        return false;
    }
    let Some(arg) = option.arg.as_deref().and_then(|arg| arg.node.as_ref()) else {
        return true;
    };
    match arg {
        NodeEnum::Boolean(value) => value.boolval,
        NodeEnum::Integer(value) => value.ival != 0,
        NodeEnum::String(value) => !is_false_word(&value.sval),
        _ => true,
    }
}

/// 서버의 `parse_bool`처럼 false, no, off, 0의 앞부분을 false로 읽는다.
fn is_false_word(word: &str) -> bool {
    let word = word.to_ascii_lowercase();
    !word.is_empty()
        && (["false", "no", "0"]
            .iter()
            .any(|full| full.starts_with(&word))
            || (word.len() >= 2 && "off".starts_with(&word)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn danger(sql: &str) -> Option<Danger> {
        PgQueryInspector.danger(sql)
    }

    #[test]
    fn finds_the_four_kinds() {
        assert_eq!(
            danger("DELETE FROM sessions"),
            Some(Danger::DeleteWithoutWhere {
                table: "sessions".into()
            })
        );
        assert_eq!(
            danger("update public.users set plan = 'pro'"),
            Some(Danger::UpdateWithoutWhere {
                table: "public.users".into()
            })
        );
        assert_eq!(
            danger("DROP TABLE a, b"),
            Some(Danger::Drop {
                kind: "TABLE".into(),
                names: vec!["a".into(), "b".into()]
            })
        );
        assert_eq!(
            danger("DROP DATABASE app"),
            Some(Danger::Drop {
                kind: "DATABASE".into(),
                names: vec!["app".into()]
            })
        );
        assert_eq!(
            danger("TRUNCATE sessions, events"),
            Some(Danger::Truncate {
                tables: vec!["sessions".into(), "events".into()]
            })
        );
    }

    #[test]
    fn statements_with_where_or_without_writes_are_safe() {
        for sql in [
            "DELETE FROM s WHERE id = 1",
            "UPDATE u SET a = 1 WHERE id = 2",
            "SELECT * FROM s",
            "EXPLAIN DELETE FROM s",
            "PREPARE p AS DELETE FROM s",
            "DELETE FROM s WHERE CURRENT OF c",
            "DELETE FROM",
            "not sql at all",
        ] {
            assert_eq!(danger(sql), None, "{sql}");
        }
    }

    #[test]
    fn finds_dangers_inside_ctes_and_explain_analyze() {
        assert_eq!(
            danger("WITH gone AS (DELETE FROM s RETURNING *) SELECT count(*) FROM gone"),
            Some(Danger::DeleteWithoutWhere { table: "s".into() })
        );
        assert_eq!(
            danger("EXPLAIN ANALYZE UPDATE u SET a = 1"),
            Some(Danger::UpdateWithoutWhere { table: "u".into() })
        );
        assert_eq!(
            danger("EXPLAIN (ANALYZE, BUFFERS) DELETE FROM s"),
            Some(Danger::DeleteWithoutWhere { table: "s".into() })
        );
    }

    #[test]
    fn explain_looks_inside_only_when_analyze_is_on() {
        for sql in [
            "EXPLAIN (ANALYZE false) DELETE FROM s",
            "EXPLAIN (ANALYZE off) DELETE FROM s",
            "EXPLAIN (ANALYZE 0) DELETE FROM s",
            "EXPLAIN (BUFFERS) DELETE FROM s",
        ] {
            assert_eq!(danger(sql), None, "{sql}");
        }
        for sql in [
            "EXPLAIN (ANALYZE true) DELETE FROM s",
            "EXPLAIN (ANALYZE on) DELETE FROM s",
            "EXPLAIN (ANALYZE) DELETE FROM s",
            "EXPLAIN (ANALYZE 1) DELETE FROM s",
        ] {
            assert!(danger(sql).is_some(), "{sql}");
        }
    }

    #[test]
    fn names_are_as_written_without_quotes() {
        assert_eq!(
            danger(r#"DELETE FROM "My Schema"."Users""#),
            Some(Danger::DeleteWithoutWhere {
                table: "My Schema.Users".into()
            })
        );
        assert_eq!(
            danger("DROP VIEW IF EXISTS v.a"),
            Some(Danger::Drop {
                kind: "VIEW".into(),
                names: vec!["v.a".into()]
            })
        );
        assert_eq!(
            danger("TRUNCATE ONLY public.a"),
            Some(Danger::Truncate {
                tables: vec!["public.a".into()]
            })
        );
    }

    #[test]
    fn drop_kinds_map_to_keywords_and_others_are_empty() {
        let kind = |sql| match danger(sql) {
            Some(Danger::Drop { kind, .. }) => kind,
            other => panic!("{sql}: {other:?}"),
        };
        assert_eq!(kind("DROP MATERIALIZED VIEW m"), "MATERIALIZED VIEW");
        assert_eq!(kind("DROP INDEX i"), "INDEX");
        assert_eq!(kind("DROP SCHEMA s CASCADE"), "SCHEMA");
        assert_eq!(kind("DROP SEQUENCE q"), "SEQUENCE");
        assert_eq!(kind("DROP FUNCTION f(int)"), "FUNCTION");
        assert_eq!(kind("DROP TYPE t"), "TYPE");
        assert_eq!(kind("DROP EXTENSION e"), "EXTENSION");
        assert_eq!(kind("DROP TRIGGER g ON t"), "");
        assert_eq!(kind("DROP DOMAIN d"), "");
    }

    /// `DropStmt`가 아닌 DROP: role, role이 가진 object, tablespace.
    #[test]
    fn drops_of_roles_owned_objects_and_tablespaces_are_dangers() {
        let drop = |kind: &str, names: &[&str]| {
            Some(Danger::Drop {
                kind: kind.into(),
                names: names.iter().map(|name| name.to_string()).collect(),
            })
        };
        assert_eq!(
            danger("DROP ROLE alice, bob"),
            drop("ROLE", &["alice", "bob"])
        );
        assert_eq!(
            danger("DROP USER IF EXISTS alice"),
            drop("ROLE", &["alice"])
        );
        assert_eq!(danger("DROP GROUP staff"), drop("ROLE", &["staff"]));
        assert_eq!(
            danger("DROP OWNED BY alice, CURRENT_USER CASCADE"),
            drop("OWNED", &["alice", "CURRENT_USER"])
        );
        assert_eq!(
            danger("DROP TABLESPACE fast"),
            drop("TABLESPACE", &["fast"])
        );
    }

    #[test]
    fn data_modifying_ctes_report_the_first_danger_in_order() {
        assert_eq!(
            danger(
                "WITH a AS (UPDATE x SET v = 1 RETURNING 1), b AS (DELETE FROM y RETURNING 1) SELECT 1"
            ),
            Some(Danger::UpdateWithoutWhere { table: "x".into() })
        );
        assert_eq!(
            danger("WITH a AS (DELETE FROM y WHERE id = 1 RETURNING 1) DELETE FROM z"),
            Some(Danger::DeleteWithoutWhere { table: "z".into() })
        );
        assert_eq!(
            danger("WITH a AS (DELETE FROM y WHERE id = 1 RETURNING 1) SELECT 1"),
            None
        );
    }
}
