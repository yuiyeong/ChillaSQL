import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { closeCatalog, loadCatalog } from "../../shared/api/commands";
import { catalogFixture } from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";
import { useTabs } from "../editor/tabsStore";
import { useSchema } from "./schemaStore";
import { useSchemaLifecycle } from "./useSchemaLifecycle";

function tabWith(connection: string | null): string {
  const id = useTabs.getState().newTab();
  useTabs.getState().setConnection(id, connection);
  return id;
}

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
});

afterEach(() => {
  useSchema.getState().reset();
});

test("loads_the_catalog_of_the_active_tab", async () => {
  renderHook(() => useSchemaLifecycle());
  act(() => void tabWith(null));
  expect(loadCatalog).not.toHaveBeenCalled();

  const id = useTabs.getState().activeId!;
  act(() => useTabs.getState().setConnection(id, "local"));
  await vi.waitFor(() => expect(loadCatalog).toHaveBeenCalledWith("local"));

  act(() => void tabWith("staging"));
  await vi.waitFor(() => expect(loadCatalog).toHaveBeenCalledWith("staging"));
});

test("forgets_catalogs_no_tab_uses", async () => {
  renderHook(() => useSchemaLifecycle());
  let first = "";
  act(() => {
    first = tabWith("local");
  });
  let second = "";
  act(() => {
    second = tabWith("local");
  });
  await vi.waitFor(() =>
    expect(useSchema.getState().entries.local?.status).toBe("ready"),
  );

  act(() => useTabs.getState().close(first));
  expect(closeCatalog).not.toHaveBeenCalled();

  act(() => useTabs.getState().close(second));
  await vi.waitFor(() => expect(closeCatalog).toHaveBeenCalledWith("local"));
  expect(useSchema.getState().entries.local).toBeUndefined();
});
