import { expect, test } from "vitest";
import type { ResultColumn, TypeInfo } from "../../shared/api/types";
import { resultColumns } from "../../test/fixtures";
import { rowsInView, toCsv, toJson } from "./exportRows";
import { rowViewOf } from "./grid";

const type = (name: string, category: string): TypeInfo => ({
  oid: 1,
  modifier: -1,
  name,
  category,
});

test("csv_quotes_like_copy", () => {
  const columns = resultColumns("id", "a,b");
  const rows = [
    ["1", "a,b"],
    ["2", 'say "hi"'],
    ["3", "line1\nline2"],
    ["4", "cr\rhere"],
    ["5", ""],
    ["6", null],
    ["7", "한글"],
  ];

  expect(toCsv(columns, rows)).toBe(
    [
      'id,"a,b"',
      '1,"a,b"',
      '2,"say ""hi"""',
      '3,"line1\nline2"',
      '4,"cr\rhere"',
      '5,""',
      "6,",
      "7,한글",
      "",
    ].join("\n"),
  );
});

test("csv_of_no_rows_is_the_header_line", () => {
  expect(toCsv(resultColumns("id", "name"), [])).toBe("id,name\n");
});

test("json_types", () => {
  const columns = resultColumns(
    "big",
    "num",
    "flag",
    "doc",
    "label",
    "empty",
    "other",
    "unknown",
  );
  const types = [
    type("bigint", "N"),
    type("numeric", "N"),
    type("boolean", "B"),
    type("jsonb", "U"),
    type("text", "S"),
    type("integer", "N"),
    type("money", "N"),
    undefined,
  ];
  const rows = [
    [
      "9007199254740993",
      "NaN",
      "t",
      '{"a": [1, 2]}',
      "123",
      null,
      "$1.00",
      "42",
    ],
    ["-1.5e3", "Infinity", "f", "[]", "x", "0", "-$2.00", null],
  ];

  const text = toJson(columns, rows, types);

  expect(text).toBe(
    [
      "[",
      '{"big":9007199254740993,"num":"NaN","flag":true,"doc":{"a": [1, 2]},"label":"123","empty":null,"other":"$1.00","unknown":"42"},',
      '{"big":-1.5e3,"num":"Infinity","flag":false,"doc":[],"label":"x","empty":0,"other":"-$2.00","unknown":null}',
      "]",
    ].join("\n"),
  );
  expect(JSON.parse(text)).toEqual([
    {
      // text에는 그대로 있다. JSON.parse가 double로 읽을 뿐이다.
      big: Number("9007199254740993"),
      num: "NaN",
      flag: true,
      doc: { a: [1, 2] },
      label: "123",
      empty: null,
      other: "$1.00",
      unknown: "42",
    },
    {
      big: -1500,
      num: "Infinity",
      flag: false,
      doc: [],
      label: "x",
      empty: 0,
      other: "-$2.00",
      unknown: null,
    },
  ]);
});

test("json_escapes_strings", () => {
  const text = toJson(
    resultColumns('say "hi"'),
    [['a"b\\c\nd\u0001한글']],
    [type("text", "S")],
  );

  expect(text).toBe('[\n{"say \\"hi\\"":"a\\"b\\\\c\\nd\\u0001한글"}\n]');
  expect(JSON.parse(text)).toEqual([{ 'say "hi"': 'a"b\\c\nd\u0001한글' }]);
});

test("json_duplicate_names_get_suffixes", () => {
  const columns: ResultColumn[] = resultColumns("id", "id", "id", "id_2", "x");
  const text = toJson(columns, [["1", "2", "3", "4", "5"]], []);

  expect(text).toBe(
    '[\n{"id":"1","id_2":"2","id_3":"3","id_2_2":"4","x":"5"}\n]',
  );
});

test("json_one_row_per_line", () => {
  const text = toJson(resultColumns("n"), [["1"], ["2"], ["3"]], []);

  expect(text).toBe('[\n{"n":"1"},\n{"n":"2"},\n{"n":"3"}\n]');
});

test("empty_result_is_an_empty_array", () => {
  expect(toJson(resultColumns("id"), [], [])).toBe("[]");
  expect(JSON.parse(toJson(resultColumns("id"), [], []))).toEqual([]);
});

test("rows_in_view_follow_the_sort_order", () => {
  const rows = [["a"], ["b"], ["c"]];

  expect(rowsInView(rows, rowViewOf(null))).toEqual(rows);
  expect(rowsInView(rows, rowViewOf(Int32Array.from([2, 0, 1])))).toEqual([
    ["c"],
    ["a"],
    ["b"],
  ]);
});
