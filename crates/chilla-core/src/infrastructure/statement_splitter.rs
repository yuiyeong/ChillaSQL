use pg_query::protobuf::{KeywordKind, ScanResult, Token};

use crate::application::{SplitError, StatementSplitter};
use crate::domain::{ParameterSpan, StatementSpan};

fn scan(sql: &str) -> Result<ScanResult, SplitError> {
    pg_query::scan(sql).map_err(|e| SplitError {
        // `Scan`의 Display는 영어 접두어("Error scanning: ")를 붙이므로 message만 꺼낸다.
        message: match e {
            pg_query::Error::Scan(message) => message,
            other => other.to_string(),
        },
    })
}

/// `pg_query::scan`의 token으로 문장을 나눈다.
///
/// `split_with_parser`는 text 어디든 문법 오류가 있으면 전체가 실패하고, `split_with_scanner`는
/// keyword 없이 시작하는 문장을 빠뜨리며 `BEGIN ATOMIC` body를 쪼갠다. 그래서 token을 직접 본다.
pub struct PgQuerySplitter;

impl StatementSplitter for PgQuerySplitter {
    fn split(&self, sql: &str) -> Result<Vec<StatementSpan>, SplitError> {
        let scanned = scan(sql)?;

        let mut spans = Vec::new();
        let mut current: Option<StatementSpan> = None;
        let mut paren_depth = 0usize;
        let mut atomic_depth = 0usize;
        let mut previous = None;

        for token in &scanned.tokens {
            let kind = token.token();
            match kind {
                Token::SqlComment | Token::CComment => continue,
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

            // scanner의 offset은 `sql` 안의 byte offset이라 음수가 아니다.
            let (start, end) = (token.start as usize, token.end as usize);
            match &mut current {
                Some(span) => span.end = end,
                None => current = Some(StatementSpan { start, end }),
            }
        }
        spans.extend(current);
        Ok(spans)
    }

    fn parameters(&self, sql: &str) -> Result<Vec<ParameterSpan>, SplitError> {
        let scanned = scan(sql)?;
        // 주석은 건너뛰고 남은 token만 본다. `:`와 이름이 붙어 있는지는 offset으로 가린다.
        let tokens: Vec<_> = scanned
            .tokens
            .iter()
            .filter(|t| !matches!(t.token(), Token::SqlComment | Token::CComment))
            .collect();

        let mut params = Vec::new();
        let mut bracket_depth = 0usize;
        for (i, token) in tokens.iter().enumerate() {
            match token.token() {
                Token::Ascii91 => bracket_depth += 1,
                Token::Ascii93 => bracket_depth = bracket_depth.saturating_sub(1),
                // `a[lo:hi]`가 `:id`와 같은 모양이라 `[ ]` 안은 보지 않는다.
                Token::Ascii58 if bracket_depth == 0 => {
                    let Some(next) = tokens.get(i + 1) else {
                        continue;
                    };
                    if next.start != token.end {
                        continue;
                    }
                    let (start, end) = (next.start as usize, next.end as usize);
                    let name = &sql[start..end];
                    // `:"q"`는 psql 변수 문법이라 따옴표로 시작하는 식별자는 뺀다.
                    let is_name = match next.token() {
                        Token::Ident => !name.starts_with('"'),
                        _ => next.keyword_kind() != KeywordKind::NoKeyword,
                    };
                    if is_name {
                        params.push(ParameterSpan {
                            name: name.to_string(),
                            start: token.start as usize,
                            end,
                        });
                    }
                }
                _ => {}
            }
        }
        Ok(params)
    }
}
