import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import EditorQuickOpenModal from "./EditorQuickOpenModal.svelte";
import { TEST_IDS } from "../testids";
import type { EditorSearchResult } from "../editors";

const RESULTS: EditorSearchResult[] = [
  {
    wslPath: "/home/user/work/project/src/App.svelte",
    relativePath: "src/App.svelte",
    basename: "App.svelte",
    line: 12,
    column: 3,
  },
  {
    wslPath: "/home/user/work/project/src/lib/components/InternalEditor.svelte",
    relativePath: "src/lib/components/InternalEditor.svelte",
    basename: "InternalEditor.svelte",
  },
];

function renderQuickOpen(overrides: Partial<Record<string, unknown>> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onRefresh = vi.fn();

  const view = render(EditorQuickOpenModal, {
    visible: true,
    openKey: 1,
    initialQuery: "app",
    rootDir: "/home/user/work/project",
    entries: RESULTS,
    title: "Open File",
    description: "Search within the session root",
    placeholder: "Search files",
    idleLabel: "Type to search files",
    emptyLabel: "No matching files",
    loadingLabel: "Searching files...",
    refreshLabel: "Refresh",
    closeLabel: "Dismiss",
    keyboardHintLabel: "Press Enter to open",
    onSelect,
    onClose,
    onRefresh,
    ...overrides,
  });

  return { ...view, onSelect, onClose, onRefresh };
}

describe("EditorQuickOpenModal", () => {
  it("renders basename-first results with highlight markup", () => {
    renderQuickOpen();

    expect(screen.getByTestId(TEST_IDS.internalEditorQuickOpenModal)).toBeInTheDocument();
    expect(screen.getByText("/home/user/work/project")).toBeInTheDocument();
    expect(screen.getByText("Press Enter to open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /App\.svelte/i })).toBeInTheDocument();
    expect(screen.getByText("App", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
  });

  it("supports local query typing and selection", async () => {
    const { onSelect } = renderQuickOpen({ initialQuery: "editor" });

    const input = screen.getByTestId(TEST_IDS.internalEditorQuickOpenInput);
    await fireEvent.input(input, { target: { value: "internal" } });
    expect((input as HTMLInputElement).value).toBe("internal");

    await screen.findByRole("option", { name: /InternalEditor\.svelte/i });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(RESULTS[1]);
  });

  it("closes on escape and shows loading state", async () => {
    const { onClose } = renderQuickOpen({
      busy: true,
      entries: [],
      initialQuery: "",
    });

    expect(screen.getByText("Searching files...")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    const input = screen.getByTestId(TEST_IDS.internalEditorQuickOpenInput);
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps existing results visible while loading", () => {
    renderQuickOpen({
      busy: true,
      initialQuery: "app",
      entries: RESULTS,
    });

    expect(screen.getByText("Searching files...")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /App\.svelte/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /InternalEditor\.svelte/i })).not.toBeInTheDocument();
  });

  it("allows selecting filtered results while loading", async () => {
    const { onSelect } = renderQuickOpen({
      busy: true,
    });

    const input = screen.getByTestId(TEST_IDS.internalEditorQuickOpenInput);
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("shows an idle label instead of the empty-result label for empty queries", () => {
    renderQuickOpen({
      busy: false,
      initialQuery: "",
      entries: [],
    });

    expect(screen.getByText("Type to search files")).toBeInTheDocument();
    expect(screen.queryByText("No matching files")).not.toBeInTheDocument();
  });

  it("exposes refresh action while loading", async () => {
    const { onRefresh } = renderQuickOpen({
      busy: true,
      initialQuery: "app",
      entries: RESULTS,
    });

    const refreshButtons = screen.getAllByRole("button", { name: "Refresh" });
    await fireEvent.click(refreshButtons[0]);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
