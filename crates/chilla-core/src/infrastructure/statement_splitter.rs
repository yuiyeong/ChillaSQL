use pg_query::protobuf::Token;

use crate::application::{SplitError, StatementSplitter};
use crate::domain::StatementSpan;

/// `pg_query::scan`의 token으로 문장을 나눈다.
///
/// `split_with_parser`는 text 어디든 문법 오류가 있으면 전체가 실패하고, `split_with_scanner`는
/// keyword 없이 시작하는 문장을 빠뜨리며 `BEGIN ATOMIC` body를 쪼갠다. 그래서 token을 직접 본다.
pub struct PgQuerySplitter;

impl StatementSplitter for PgQuerySplitter {
    fn split(&self, sql: &str) -> Result<Vec<StatementSpan>, SplitError> {
        let scanned = pg_query::scan(sql).map_err(|e| SplitError {
            message: e.to_string(),
        })?;

        let mut spans = Vec::new();
        let mut current: Option<StatementSpan> = None;
        let mut paren_depth = 0usize;
        let mut atomic_depth = 0usize;
        let mut previous = None;

        for token in &scanned.tokens {
            let kind = token.token();
            if matches!(kind, Token::SqlComment | Token::CComment) {
                continue;
            }

            match kind {
                Token::Ascii59 if paren_depth == 0 && atomic_depth == 0 => {
                    spans.extend(current.take());
                    previous = Some(kind);
                    continue;
                }
                Token::Ascii40 => paren_depth += 1,
                Token::Ascii41 => paren_depth = paren_depth.saturating_sub(1),
                // psql과 같은 규칙: `BEGIN ATOMIC`이어야 body가 열린다. `BEGIN;`은 트랜잭션이다.
                Token::Atomic if previous == Some(Token::BeginP) => atomic_depth = 1,
                Token::Case if atomic_depth > 0 => atomic_depth += 1,
                Token::EndP if atomic_depth > 0 => atomic_depth -= 1,
                _ => {}
            }
            previous = Some(kind);

            let (start, end) = (token.start as usize, token.end as usize);
            match &mut current {
                Some(span) => span.end = end,
                None => current = Some(StatementSpan { start, end }),
            }
        }
        spans.extend(current);
        Ok(spans)
    }
}
