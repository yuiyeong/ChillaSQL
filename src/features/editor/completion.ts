import type {
  Completion,
  CompletionContext,
  CompletionSource,
} from "@codemirror/autocomplete";
import {
  PostgreSQL,
  schemaCompletionSource,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import { syntaxTree } from "@codemirror/language";
import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import type { Catalog, Relation } from "../../shared/api/types";
import { t } from "../../shared/i18n/t";
import { isView, relationNamed, relationsOf } from "../../shared/sql/catalog";
import { quoteIdent, reservedSet } from "../../shared/sql/identifiers";

/** 문서의 catalog를 바꾼다. 활성 탭 접속의 catalog를 SqlEditor가 넣는다. null이면 뺀다. */
export const setCatalog = StateEffect.define<Catalog | null>();

/** 문서의 catalog. 없으면 null이다. */
export const catalogField = StateField.define<Catalog | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCatalog)) value = effect.value;
    }
    return value;
  },
});

/**
 * 문서 catalog의 자동완성. source는 language data로 내놓아 keyword(`sql()`의 것)와 함께 쓰인다.
 * catalog가 없으면 아무것도 내놓지 않는다.
 */
export const catalogCompletion: Extension = [
  catalogField,
  EditorState.languageData.of((state) => {
    const catalog = state.field(catalogField);
    return catalog === null
      ? []
      : catalogSources(catalog).map((autocomplete) => ({ autocomplete }));
  }),
];

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

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

/** relation별 컬럼 completion. namespace와 별칭 없는 컬럼 source가 같은 배열을 쓴다. */
type ColumnCompletions = (relation: Relation) => Completion[];

function columnCompletions(catalog: Catalog): ColumnCompletions {
  const reserved = reservedSet(catalog);
  const built = new Map<Relation, Completion[]>();
  return (relation) => {
    let columns = built.get(relation);
    if (columns === undefined) {
      columns = relation.columns.map((column) =>
        named(column.name, reserved, {
          type: "column",
          detail: `${relation.name} · ${column.type}`,
        }),
      );
      built.set(relation, columns);
    }
    return columns;
  };
}

function namespaceOf(
  catalog: Catalog,
  columns: ColumnCompletions,
): SQLNamespace {
  const reserved = reservedSet(catalog);
  const namespace: Record<string, SQLNamespace> = {};
  for (const schema of catalog.schemas) {
    const tables: Record<string, SQLNamespace> = {};
    for (const relation of relationsOf(catalog, schema)) {
      const view = isView(relation);
      tables[namespaceKey(relation.name)] = {
        self: named(relation.name, reserved, {
          type: view ? "view" : "table",
          detail: view ? `${schema} · ${t("completion.view")}` : schema,
        }),
        children: columns(relation),
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
  const name = path[path.length - 1];
  const schemas =
    path.length === 2 ? [path[0]] : path.length === 1 ? catalog.searchPath : [];
  for (const schema of schemas) {
    const found = relationNamed(catalog, schema, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

const PLAIN_WORD = /^[\w$]*$/;

/** 별칭 없이 쓰는 컬럼: 그 문장의 테이블들의 컬럼이다. */
function columnSource(
  catalog: Catalog,
  columns: ColumnCompletions,
): CompletionSource {
  return (context) => {
    const at = plainWord(context);
    if (at === null) return null;
    const options = statementTables(context.state, context.pos).flatMap(
      (path) => {
        const relation = findRelation(catalog, path);
        return relation === undefined ? [] : columns(relation);
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
    const columns = columnCompletions(catalog);
    sources = [
      schemaCompletionSource({
        dialect: PostgreSQL,
        schema: namespaceOf(catalog, columns),
        defaultSchema: catalog.searchPath[0],
      }),
      columnSource(catalog, columns),
      functionSource(catalog),
    ];
    sourcesByCatalog.set(catalog, sources);
  }
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
