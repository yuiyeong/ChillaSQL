import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { click } from "../../test/click";
import {
  catalogFixture,
  connection,
  openProjectWith,
  relation,
} from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/clipboard");
vi.mock("../workspace/commands", () => ({ selectFirstRows: vi.fn() }));

import { copyText } from "../../shared/api/clipboard";
import { loadCatalog, loadTableDetails } from "../../shared/api/commands";
import { selectFirstRows } from "../workspace/commands";
import { useTabs } from "../editor/tabsStore";
import { SchemaView } from "./SchemaView";
import { nodeKey, useSchema, type SchemaEntry } from "./schemaStore";

function activeTab(connectionName: string | null) {
  act(() => {
    const id = useTabs.getState().newTab();
    useTabs.getState().setConnection(id, connectionName);
  });
}

function setEntry(patch: Partial<SchemaEntry>, name = "local") {
  act(() =>
    useSchema.setState({
      entries: {
        [name]: {
          status: "ready",
          catalog: catalogFixture(),
          error: null,
          details: {},
          expanded: new Set([
            nodeKey(["public"]),
            nodeKey(["public", "tables"]),
          ]),
          ...patch,
        },
      },
    }),
  );
}

function renderView(onChooseConnection = vi.fn()) {
  render(<SchemaView onChooseConnection={onChooseConnection} />);
  return onChooseConnection;
}

/** 그 이름으로 시작하는 줄. 이름 뒤에는 오른쪽 표시가 붙을 수 있다. */
const row = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}( |$)`) });

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  openProjectWith([
    connection("local", { color: "green", database: "chilla_test" }),
  ]);
});

test("shows_no_connection_and_choose_button", async () => {
  activeTab(null);
  const onChoose = renderView();

  expect(screen.getByText("No connection in this tab")).toBeInTheDocument();
  await click(screen.getByRole("button", { name: "Choose connection" }));
  expect(onChoose).toHaveBeenCalledTimes(1);
});

test("no_tab_has_no_choose_button", () => {
  renderView();
  expect(screen.getByText("No connection in this tab")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Choose connection" }),
  ).toBeNull();
});

test("header_shows_the_connection", async () => {
  activeTab("local");
  setEntry({});
  renderView();

  const header = screen.getByTestId("schema-header");
  expect(within(header).getByText("local")).toBeInTheDocument();
  expect(within(header).getByText("chilla_test")).toHaveClass("font-mono");
  expect(within(header).getByTestId("connection-dot")).toBeInTheDocument();

  await click(screen.getByRole("button", { name: "Refresh schema" }));
  expect(loadCatalog).toHaveBeenCalledWith("local");
});

test("loading_before_the_first_catalog", () => {
  activeTab("local");
  setEntry({ status: "loading", catalog: null });
  renderView();
  expect(screen.getByText("Loading")).toBeInTheDocument();
});

test("failed_shows_the_error_and_retry", async () => {
  activeTab("local");
  setEntry({
    status: "failed",
    catalog: null,
    error: "Could not read the schema: boom",
  });
  renderView();

  expect(
    screen.getByText("Could not read the schema: boom"),
  ).toBeInTheDocument();
  await click(screen.getByRole("button", { name: "Retry" }));
  expect(loadCatalog).toHaveBeenCalledWith("local");
});

test("rows_render_like_the_canvas", () => {
  activeTab("local");
  setEntry({
    expanded: new Set(
      [
        ["public"],
        ["public", "tables"],
        ["public", "tables", "users"],
        ["public", "tables", "users", "columns"],
      ].map(nodeKey),
    ),
  });
  renderView();

  const id = row("id");
  expect(within(id).getByText("PK")).toBeInTheDocument();
  expect(within(id).getByText("bigint")).toBeInTheDocument();
  expect(id).toHaveStyle({ paddingLeft: `${8 + 4 * 14}px` });
  expect(within(row("email")).getByText("c")).toBeInTheDocument();

  const columns = row("Columns");
  expect(columns).toHaveClass("text-fg-2");
  expect(columns).toHaveAttribute("aria-expanded", "true");
  expect(row("users")).toHaveStyle({ paddingLeft: `${8 + 2 * 14}px` });
  expect(within(row("users")).getByText("T")).toBeInTheDocument();
  expect(row("billing")).toHaveAttribute("aria-expanded", "false");
});

test("clicking_a_schema_toggles_it", async () => {
  activeTab("local");
  setEntry({});
  renderView();

  await click(row("billing"));
  expect(row("billing")).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByRole("button", { name: "Tables" })).toHaveLength(2);
});

test("expanding_indexes_loads_details", async () => {
  vi.mocked(loadTableDetails).mockResolvedValue({
    indexes: [
      {
        name: "users_pkey",
        definition: "CREATE UNIQUE INDEX users_pkey …",
        unique: true,
        primary: true,
      },
    ],
    constraints: [],
  });
  activeTab("local");
  setEntry({
    expanded: new Set(
      [["public"], ["public", "tables"], ["public", "tables", "users"]].map(
        nodeKey,
      ),
    ),
  });
  renderView();

  await click(row("Indexes"));

  expect(loadTableDetails).toHaveBeenCalledWith("local", 1);
  const index = await screen.findByRole("button", { name: /^users_pkey/ });
  expect(within(index).getByText("unique")).toBeInTheDocument();
  expect(index).toHaveAttribute("title", "CREATE UNIQUE INDEX users_pkey …");
});

test("constraint_titles_show_the_definition", () => {
  activeTab("local");
  setEntry({
    expanded: new Set(
      [
        ["public"],
        ["public", "tables"],
        ["public", "tables", "users"],
        ["public", "tables", "users", "constraints"],
      ].map(nodeKey),
    ),
    details: {
      1: {
        status: "ready",
        error: null,
        details: {
          indexes: [],
          constraints: [
            {
              name: "users_org_fkey",
              kind: "foreign_key",
              definition: "FOREIGN KEY (org) REFERENCES orgs(id)",
            },
          ],
        },
      },
    },
  });
  renderView();

  const constraint = row("users_org_fkey");
  expect(within(constraint).getByText("FOREIGN KEY")).toBeInTheDocument();
  expect(constraint).toHaveAttribute(
    "title",
    "FOREIGN KEY (org) REFERENCES orgs(id)",
  );
});

test("materialized_views_are_labeled", () => {
  activeTab("local");
  setEntry({
    catalog: catalogFixture({
      relations: [
        relation(4, "public", "active_users", [], "materialized_view"),
      ],
    }),
    expanded: new Set([["public"], ["public", "views"]].map(nodeKey)),
  });
  renderView();

  const view = row("active_users");
  expect(within(view).getByText("V")).toBeInTheDocument();
  expect(within(view).getByText("materialized")).toBeInTheDocument();
});

function tableFixture() {
  activeTab("local");
  setEntry({
    catalog: catalogFixture({
      relations: [
        relation(9, "public", "Order Items", [["id", "bigint", true]]),
      ],
    }),
    expanded: new Set(
      [
        ["public"],
        ["public", "tables"],
        ["public", "tables", "Order Items"],
        ["public", "tables", "Order Items", "columns"],
      ].map(nodeKey),
    ),
  });
  renderView();
}

test("double_clicking_a_table_selects_first_rows", () => {
  tableFixture();
  fireEvent.doubleClick(row("Order Items"));
  expect(selectFirstRows).toHaveBeenCalledWith(
    expect.objectContaining({ oid: 9, name: "Order Items" }),
    new Set(["select", "user"]),
  );
});

test("context_menu_of_a_table", async () => {
  tableFixture();
  fireEvent.contextMenu(row("Order Items"), { clientX: 30, clientY: 50 });

  const menu = screen.getByRole("menu", { name: "Order Items" });
  expect(menu).toHaveStyle({ left: "30px", top: "50px" });
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "Select first rowsDouble-click",
    "Copy name",
  ]);
  await click(items[0]);
  expect(selectFirstRows).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("context_menu_of_a_column_only_copies", () => {
  tableFixture();
  fireEvent.contextMenu(row("id"), { clientX: 30, clientY: 50 });
  const menu = screen.getByRole("menu", { name: "id" });
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Copy name"]);
});

test("groups_have_no_menu", () => {
  tableFixture();
  fireEvent.contextMenu(row("Columns"), { clientX: 30, clientY: 50 });
  expect(screen.queryByRole("menu")).toBeNull();
});

test("copy_name_copies_the_quoted_name_and_toasts", async () => {
  vi.mocked(copyText).mockResolvedValue();
  tableFixture();
  fireEvent.contextMenu(row("Order Items"), { clientX: 30, clientY: 50 });

  await click(screen.getByRole("menuitem", { name: "Copy name" }));

  expect(copyText).toHaveBeenCalledWith('"Order Items"');
  expect(await screen.findByRole("status")).toHaveTextContent(
    'Copied "Order Items"',
  );
});
