import type { Cell } from "../../shared/api/types";

/** 결과 표의 화면 내 정렬. 한 열만이다. 없으면 null */
export type SortState = { column: number; direction: "asc" | "desc" } | null;

/** header 이름을 누를 때마다 오름차순 → 내림차순 → 정렬 없음. 다른 열을 누르면 그 열의 오름차순이다. */
export function nextSort(current: SortState, column: number): SortState {
  if (current === null || current.column !== column) {
    return { column, direction: "asc" };
  }
  return current.direction === "asc" ? { column, direction: "desc" } : null;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** `-Infinity` < 수 < `Infinity` < `NaN` 순서의 자리 */
const RANK_FINITE = 1;
const SPECIAL_RANKS: Record<string, number> = {
  "-Infinity": 0,
  Infinity: 2,
  NaN: 3,
};

/** 수로 읽은 값. `int`는 앞 0을, `frac`는 뒤 0을 뺐다. 0은 부호가 없다. */
interface NumericKey {
  rank: number;
  negative: boolean;
  int: string;
  frac: string;
}

/** 수로 읽을 수 없으면 null. `Number`로 바꾸지 않는다(2^53을 넘는 bigint, numeric의 자릿수). */
function numericKey(value: string): NumericKey | null {
  const special = SPECIAL_RANKS[value];
  if (special !== undefined) {
    return { rank: special, negative: false, int: "", frac: "" };
  }
  if (!DECIMAL.test(value)) return null;
  const negative = value.startsWith("-");
  const [int, frac = ""] = (negative ? value.slice(1) : value).split(".");
  const key = {
    rank: RANK_FINITE,
    negative,
    int: int.replace(/^0+/, ""),
    frac: frac.replace(/0+$/, ""),
  };
  // -0과 0은 같다.
  if (key.int === "" && key.frac === "") key.negative = false;
  return key;
}

function compareText(a: string, b: string): number {
  // JS의 문자열 비교는 UTF-16 code unit 순이다(`COLLATE "C"`와 같은 순).
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 부호, 정수부 길이, 정수부, 소수부 순으로 비교한다. */
function compareKeys(a: NumericKey, b: NumericKey): number {
  if (a.rank !== b.rank || a.rank !== RANK_FINITE) return a.rank - b.rank;
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const magnitude =
    a.int.length - b.int.length ||
    compareText(a.int, b.int) ||
    compareText(a.frac, b.frac);
  return a.negative ? -magnitude : magnitude;
}

/**
 * type category `N` 값의 비교. 수로 읽을 수 있는 값은 크기 순이고, 읽을 수 없는 값은 그 뒤에 문자열 순이다.
 * 수와 글자를 문자열로 비교하면 순서가 돌고 돌아(`9` < `10` < `1a` < `9`) 정렬이 깨지므로 둘을 나눈다.
 */
export function compareNumeric(a: string, b: string): number {
  return compareParsed(a, numericKey(a), b, numericKey(b));
}

function compareParsed(
  a: string,
  keyA: NumericKey | null,
  b: string,
  keyB: NumericKey | null,
): number {
  if (keyA !== null && keyB !== null) return compareKeys(keyA, keyB);
  if (keyA !== null) return -1;
  if (keyB !== null) return 1;
  return compareText(a, b);
}

/**
 * 보이는 위치 → rows index. 정렬이 없으면 null이다.
 * category `N`이면 값의 크기, 그 밖(모르는 type 포함)은 code unit 순이다. NULL은 오름차순에서 끝,
 * 내림차순에서 처음이다(PostgreSQL 기본). 같은 값과 NULL끼리는 결과 순서를 지킨다.
 */
export function sortOrder(
  rows: readonly Cell[][],
  sort: SortState,
  category: string | undefined,
): Int32Array | null {
  if (sort === null) return null;
  const { column, direction } = sort;
  const values: number[] = [];
  const nulls: number[] = [];
  rows.forEach((row, index) => {
    (row[column] === null ? nulls : values).push(index);
  });
  const sign = direction === "asc" ? 1 : -1;
  // 비교마다 값을 다시 읽지 않게 수는 한 번만 읽어 둔다.
  if (category === "N") {
    const keys = rows.map((row) =>
      row[column] === null ? null : numericKey(row[column]),
    );
    values.sort(
      (x, y) =>
        sign *
        compareParsed(rows[x][column]!, keys[x], rows[y][column]!, keys[y]),
    );
  } else {
    values.sort(
      (x, y) => sign * compareText(rows[x][column]!, rows[y][column]!),
    );
  }
  // Array.prototype.sort는 stable이라 같은 값은 결과 순서로 남는다.
  return Int32Array.from(
    direction === "asc" ? [...values, ...nulls] : [...nulls, ...values],
  );
}
