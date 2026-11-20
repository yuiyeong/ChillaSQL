//! 스키마 트리와 자동완성이 쓰는 DB의 catalog.

/// 접속 하나의 catalog. 인덱스와 제약조건은 따로 읽는다([`TableDetails`]).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Catalog {
    /// `current_schemas(false)` 순서. 자동완성의 기본 schema는 첫 값이다.
    pub search_path: Vec<String>,
    /// system schema를 뺀 schema, 이름 오름차순.
    pub schemas: Vec<String>,
    /// (schema, name) 오름차순. 컬럼은 테이블에 정의된 순서다.
    pub relations: Vec<Relation>,
    /// (schema, name) 중복 없이 오름차순.
    pub functions: Vec<FunctionName>,
    /// `pg_get_keywords()`에서 unreserved가 아닌 word. 이름을 따옴표로 감쌀지 정할 때 쓴다.
    pub reserved_words: Vec<String>,
}

/// 테이블이나 뷰 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relation {
    pub oid: u32,
    pub schema: String,
    pub name: String,
    pub kind: RelationKind,
    pub columns: Vec<CatalogColumn>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationKind {
    Table,
    PartitionedTable,
    ForeignTable,
    View,
    MaterializedView,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogColumn {
    pub name: String,
    /// `format_type`이 만든 이름(`timestamp with time zone`, `numeric(12,2)` 등).
    pub type_name: String,
    /// primary key에 든 컬럼이다.
    pub primary_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionName {
    pub schema: String,
    pub name: String,
}

/// 테이블 하나의 인덱스와 제약조건. 각각 이름 오름차순이다.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TableDetails {
    pub indexes: Vec<IndexInfo>,
    pub constraints: Vec<ConstraintInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexInfo {
    pub name: String,
    /// `pg_get_indexdef`의 `CREATE INDEX …` 문장.
    pub definition: String,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConstraintInfo {
    pub name: String,
    pub kind: ConstraintKind,
    /// `pg_get_constraintdef`의 정의(`FOREIGN KEY (a) REFERENCES t(id)` 등).
    pub definition: String,
}

/// 보이는 제약조건의 종류. NOT NULL과 constraint trigger는 보이지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstraintKind {
    PrimaryKey,
    ForeignKey,
    Unique,
    Check,
    Exclusion,
}

/// 결과 컬럼의 type 하나. `(oid, modifier)`는 RowDescription이 알려 준 값이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeInfo {
    pub oid: u32,
    pub modifier: i32,
    /// `format_type(oid, modifier)`가 만든 이름(`character varying(255)` 등).
    pub name: String,
    /// `pg_type.typcategory`. `N`은 숫자, `S`는 문자열, `D`는 날짜·시간, `A`는 배열 등이다.
    pub category: char,
}
