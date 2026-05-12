import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import HistoryTab from "../HistoryTab";
import type { DocumentVersion } from "../../types/demoExtras";

function v(overrides: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    id: "v1",
    version_label: "v1",
    uploaded_at: "2026-02-01T00:00:00Z",
    uploaded_by_display_name: "Alice",
    source: "upload",
    text_preview: "Body of v1.",
    summary: "First version.",
    ...overrides,
  };
}

describe("HistoryTab", () => {
  it("renders versions newest-first and exposes a Compare button when there's a target", () => {
    const onCompare = vi.fn();
    render(
      <HistoryTab
        versions={[
          v({ id: "a", version_label: "v1", uploaded_at: "2026-01-01T00:00:00Z" }),
          v({ id: "b", version_label: "v2", uploaded_at: "2026-02-01T00:00:00Z" }),
          v({ id: "c", version_label: "v3", uploaded_at: "2026-03-01T00:00:00Z" }),
        ]}
        onCompare={onCompare}
      />,
    );
    const items = screen.getAllByTestId(/^history-tab-version-/);
    expect(items.map((el) => el.getAttribute("data-testid"))).toEqual([
      "history-tab-version-c",
      "history-tab-version-b",
      "history-tab-version-a",
    ]);
    fireEvent.click(screen.getByTestId("history-tab-compare-c"));
    expect(onCompare).toHaveBeenCalled();
    expect(onCompare.mock.calls[0][0].id).toBe("b");
    expect(onCompare.mock.calls[0][1].id).toBe("c");
  });

  it("renders an empty state when no versions are present", () => {
    render(<HistoryTab versions={[]} onCompare={vi.fn()} />);
    expect(screen.getByTestId("history-tab-empty")).toBeInTheDocument();
  });

  it("does not show a Compare button on the oldest version", () => {
    render(
      <HistoryTab
        versions={[v({ id: "a", uploaded_at: "2026-01-01T00:00:00Z" })]}
        onCompare={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("history-tab-compare-a")).toBeNull();
  });
});
