import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import WorkspaceModeTabs from "../WorkspaceModeTabs";

const TABS = [
  { id: "read" as const, label: "Read" },
  { id: "negotiate" as const, label: "Negotiate" },
  { id: "history" as const, label: "History" },
];

describe("WorkspaceModeTabs", () => {
  it("renders the three mode tabs with the right labels and testids", () => {
    render(
      <WorkspaceModeTabs tabs={TABS} active="read" onChange={() => {}} />,
    );
    expect(screen.getByTestId("workspace-mode-tabs")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-mode-tab-read")).toHaveTextContent(
      "Read",
    );
    expect(
      screen.getByTestId("workspace-mode-tab-negotiate"),
    ).toHaveTextContent("Negotiate");
    expect(
      screen.getByTestId("workspace-mode-tab-history"),
    ).toHaveTextContent("History");
  });

  it("marks the active tab with aria-selected and leaves others unselected", () => {
    render(
      <WorkspaceModeTabs tabs={TABS} active="negotiate" onChange={() => {}} />,
    );
    expect(screen.getByTestId("workspace-mode-tab-negotiate")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("workspace-mode-tab-read")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByTestId("workspace-mode-tab-history")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("calls onChange with the id of the clicked tab", () => {
    const onChange = vi.fn();
    render(
      <WorkspaceModeTabs tabs={TABS} active="read" onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("workspace-mode-tab-history"));
    expect(onChange).toHaveBeenCalledWith("history");
  });

  it("uses role=tablist + role=tab so it is announceable as a tab group", () => {
    render(
      <WorkspaceModeTabs tabs={TABS} active="read" onChange={() => {}} />,
    );
    expect(
      screen.getByRole("tablist", { name: /contract workspace mode/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });
});
