//! 결과 표의 셀 편집이 필요로 하는 테이블 정보.

use super::RelationKind;

/// 편집 대상이 될 수 있는 relation 하나. 결과 열의 table OID로 찾는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditTable {
    pub oid: u32,
    /// `quote_ident(schema) || '.' || quote_ident(relname)`. SQL에 쓴다.
    pub qualified_name: String,
    /// relname 그대로. 화면 문구에 쓴다.
    pub name: String,
    pub kind: RelationKind,
    /// attnum 순. 지운 컬럼은 없다.
    pub columns: Vec<EditColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditColumn {
    /// `pg_attribute.attnum`. 결과 열의 `column_number`와 맞춘다.
    pub number: i16,
    pub name: String,
    /// `quote_ident(attname)`
    pub quoted_name: String,
    pub primary_key: bool,
    /// generated 컬럼과 `GENERATED ALWAYS` identity 컬럼은 false
    pub updatable: bool,
}
