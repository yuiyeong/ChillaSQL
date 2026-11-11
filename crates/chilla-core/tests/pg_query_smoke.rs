#[test]
fn splits_statements_ignoring_semicolon_inside_dollar_quote() {
    let sql = "SELECT 1; DO $$ BEGIN PERFORM 1; END $$; SELECT ';'";
    let statements = pg_query::split_with_parser(sql).unwrap();
    assert_eq!(statements.len(), 3);
}
