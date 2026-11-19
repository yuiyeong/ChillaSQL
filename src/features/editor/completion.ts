import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import {
  keywordCompletionSource,
  PostgreSQL,
  schemaCompletionSource,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import type { Catalog, Relation } from "../../shared/api/types";
import { t } from "../../shared/i18n/t";
import { quoteIdent, reservedSet } from "../../shared/sql/identifiers";

/** 문서의 catalog를 바꾼다. 활성 탭 접속의 catalog를 SqlEditor가 넣는다. null이면 뺀다. */
export const setCatalog = StateEffect.define<Catalog | null>();

interface CatalogCompletion {
  catalog: Catalog;
  sources: readonly CompletionSource[];
}

/** 문서의 catalog와 그것으로 만든 source. 없으면 null이다. */
export const catalogField = StateField.define<CatalogCompletion | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setCatalog)) continue;
      const catalog = effect.value;
      if (catalog === null) value = null;
      else if (value?.catalog !== catalog) {
        value = { catalog, sources: catalogSources(catalog) };
      }
    }
    return value;
  },
});

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

const VIEW_KINDS = new Set(["view", "materialized_view"]);

/** 이름에 든 `.`은 lang-sql이 경로로 나누므로 escape한다. */
function namespaceKey(name: string): string {
  return name.replace(/\./g, "\\.");
}

/** label이 그대로 SQL에 쓰일 수 없으면 quoted 이름을 넣는다. */
function named(
  label: string,
  reserved: ReadonlySet<string>,
  rest: Omit<Completion, "label">,
): Completion {
  const quoted = quoteIdent(label, reserved);
  return quoted === label
    ? { label, ...rest }
    : { label, apply: quoted, ...rest };
}

function columnCompletions(relation: Relation, reserved: ReadonlySet<string>) {
  return relation.columns.map((column) =>
    named(column.name, reserved, {
      type: "column",
      detail: `${relation.name} · ${column.type}`,
    }),
  );
}

function namespaceOf(catalog: Catalog): SQLNamespace {
  const reserved = reservedSet(catalog);
  const namespace: Record<string, SQLNamespace> = {};
  for (const schema of catalog.schemas) {
    const tables: Record<string, SQLNamespace> = {};
    for (const relation of catalog.relations) {
      if (relation.schema !== schema) continue;
      const view = VIEW_KINDS.has(relation.kind);
      tables[namespaceKey(relation.name)] = {
        self: named(relation.name, reserved, {
          type: view ? "view" : "table",
          detail: view ? `${schema} · ${t("completion.view")}` : schema,
        }),
        children: columnCompletions(relation, reserved),
      };
    }
    namespace[namespaceKey(schema)] = {
      self: named(schema, reserved, { type: "schema" }),
      children: tables,
    };
  }
  return namespace;
}

/** 이 source가 낄 자리가 아니면(문자열, 주석, `.` 뒤, 입력 없음) null이고 아니면 바꿀 범위다. */
function plainWord(context: CompletionContext): { from: number } | null {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1);
  if (/String|Comment|QuotedIdentifier/.test(node.name)) return null;
  const word = context.matchBefore(/[\w$]*$/);
  if (word === null) return null;
  if (word.from === word.to && !context.explicit) return null;
  if (context.state.sliceDoc(word.from - 1, word.from) === ".") return null;
  return { from: word.from };
}

const INTRODUCERS = new Set(["from", "join", "update", "into"]);
const IDENTIFIER = /^(Identifier|QuotedIdentifier|CompositeIdentifier)$/;

function identifierName(state: EditorState, node: SyntaxNode): string {
  const text = state.sliceDoc(node.from, node.to);
  return node.name === "QuotedIdentifier"
    ? text.slice(1, -1).replace(/""/g, '"')
    : text;
}

function pathOf(state: EditorState, node: SyntaxNode): string[] {
  if (node.name !== "CompositeIdentifier") return [identifierName(state, node)];
  const path: string[] = [];
  for (let part = node.firstChild; part; part = part.nextSibling) {
    if (part.name === "Identifier" || part.name === "QuotedIdentifier") {
      path.push(identifierName(state, part));
    }
  }
  return path;
}

/** 커서가 있는 문장에서 FROM, JOIN, UPDATE, INTO 뒤에 쓴 테이블 이름. FROM의 `,` 목록도 본다. */
function statementTables(state: EditorState, pos: number): string[][] {
  let statement: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (statement !== null && statement.name !== "Statement") {
    statement = statement.parent;
  }
  if (statement === null) return [];
  const tables: string[][] = [];
  let keyword: string | null = null;
  let expectTable = false;
  for (let child = statement.firstChild; child; child = child.nextSibling) {
    if (child.name === "Keyword") {
      keyword = state.sliceDoc(child.from, child.to).toLowerCase();
      expectTable = INTRODUCERS.has(keyword);
    } else if (IDENTIFIER.test(child.name)) {
      if (expectTable) tables.push(pathOf(state, child));
      expectTable = false;
    } else {
      const comma = state.sliceDoc(child.from, child.to) === ",";
      expectTable = comma && keyword !== null && INTRODUCERS.has(keyword);
    }
  }
  return tables;
}

/** 이름만 쓴 테이블은 search_path의 앞 schema부터 찾는다. */
function findRelation(catalog: Catalog, path: string[]): Relation | undefined {
  if (path.length === 2) {
    const [schema, name] = path;
    return catalog.relations.find(
      (r) => r.schema === schema && r.name === name,
    );
  }
  if (path.length !== 1) return undefined;
  for (const schema of catalog.searchPath) {
    const found = catalog.relations.find(
      (r) => r.schema === schema && r.name === path[0],
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

const PLAIN_WORD = /^[\w$]*$/;

/** 별칭 없이 쓰는 컬럼: 그 문장의 테이블들의 컬럼이다. */
function columnSource(catalog: Catalog): CompletionSource {
  const reserved = reservedSet(catalog);
  return (context) => {
    const at = plainWord(context);
    if (at === null) return null;
    const options = statementTables(context.state, context.pos).flatMap(
      (path) => {
        const relation = findRelation(catalog, path);
        return relation === undefined
          ? []
          : columnCompletions(relation, reserved);
      },
    );
    if (options.length === 0) return null;
    return { from: at.from, options, validFor: PLAIN_WORD };
  };
}

/** 함수 이름. 같은 이름이 여러 schema에 있으면 search_path, 그다음 `pg_catalog`의 것을 detail로 쓴다. */
function functionSource(catalog: Catalog): CompletionSource {
  const reserved = reservedSet(catalog);
  const rank = (schema: string) => {
    const index = catalog.searchPath.indexOf(schema);
    if (index >= 0) return index;
    return schema === "pg_catalog" ? catalog.searchPath.length : Infinity;
  };
  const best = new Map<string, string>();
  for (const { schema, name } of catalog.functions) {
    const current = best.get(name);
    if (current === undefined || rank(schema) < rank(current))
      best.set(name, schema);
  }
  const options = [...best].map(([name, schema]) =>
    named(name, reserved, { type: "function", detail: schema }),
  );
  return (context) => {
    const at = plainWord(context);
    if (at === null) return null;
    return { from: at.from, options, validFor: PLAIN_WORD };
  };
}

const sourcesByCatalog = new WeakMap<Catalog, readonly CompletionSource[]>();

/** 한 catalog의 source(schema·테이블·별칭 컬럼, 별칭 없는 컬럼, 함수). catalog마다 한 번 만든다. */
export function catalogSources(catalog: Catalog): readonly CompletionSource[] {
  let sources = sourcesByCatalog.get(catalog);
  if (sources === undefined) {
    sources = [
      schemaCompletionSource({
        dialect: PostgreSQL,
        schema: namespaceOf(catalog),
        defaultSchema: catalog.searchPath[0],
      }),
      columnSource(catalog),
      functionSource(catalog),
    ];
    sourcesByCatalog.set(catalog, sources);
  }
  return sources;
}

const CATALOG_SOURCE_COUNT = 3;

const keywordSource = keywordCompletionSource(PostgreSQL, true);

/** 문서 catalog의 i번째 source를 부른다. catalog가 없으면 null이다. */
function fromDocument(index: number): CompletionSource {
  return (context) => {
    const source = context.state.field(catalogField, false)?.sources[index];
    return source === undefined
      ? null
      : (source(context) as
          CompletionResult | null | Promise<CompletionResult | null>);
  };
}

const sources: readonly CompletionSource[] = [
  keywordSource,
  ...Array.from({ length: CATALOG_SOURCE_COUNT }, (_, i) => fromDocument(i)),
];

/** keyword(대문자)와 문서 catalog의 source. autocompletion의 override에 넣는다. */
export function sqlCompletionSources(): readonly CompletionSource[] {
  return sources;
}

const KIND_LETTER: Record<string, string> = {
  schema: "s",
  column: "c",
  table: "t",
  view: "t",
  // lang-sql이 별칭에 붙이는 type
  constant: "t",
  function: "f",
  keyword: "k",
  type: "k",
  // lang-sql keyword source의 builtin(`now`, `coalesce` 등)
  variable: "k",
};

/** popup의 kind 글자. */
export function kindLetter(completion: Completion): string {
  return KIND_LETTER[completion.type ?? ""] ?? "";
}
