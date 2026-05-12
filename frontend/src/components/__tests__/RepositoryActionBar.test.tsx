import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import RepositoryActionBar from "../RepositoryActionBar";
import type { ContractListItem } from "../../types/contracts";

function row(id: string, overrides: Partial<ContractListItem> = {}): ContractListItem {
  return {
    id,
    title: `Contract ${id}`,
    status: "ready",
    mime_type: "application/pdf",
    file_hash_sha256: "0".repeat(64),
    page_count: 1,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

describe("RepositoryActionBar", () => {
  it("shows the selected count", () => {
    render(
      <RepositoryActionBar
        selectedRows={[row("a"), row("b"), row("c")]}
        knownTags={[]}
        onApplyTag={vi.fn()}
        onArchive={vi.fn()}
        onMoveToFolder={vi.fn()}
        onExportCsv={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("repository-action-bar-count"),
    ).toHaveTextContent("3 selected");
  });

  it("Tag menu lists existing tags and applies one on click", () => {
    const onApplyTag = vi.fn();
    render(
      <RepositoryActionBar
        selectedRows={[row("a")]}
        knownTags={["nda", "msa"]}
        onApplyTag={onApplyTag}
        onArchive={vi.fn()}
        onMoveToFolder={vi.fn()}
        onExportCsv={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("repository-action-tag"));
    fireEvent.click(screen.getByTestId("repository-action-tag-existing-nda"));
    expect(onApplyTag).toHaveBeenCalledWith("nda");
  });

  it("Archive requires a confirm step", () => {
    const onArchive = vi.fn();
    render(
      <RepositoryActionBar
        selectedRows={[row("a")]}
        knownTags={[]}
        onApplyTag={vi.fn()}
        onArchive={onArchive}
        onMoveToFolder={vi.fn()}
        onExportCsv={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("repository-action-archive"));
    expect(onArchive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("repository-action-archive-commit"));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("Move dropdown emits the chosen folder", () => {
    const onMoveToFolder = vi.fn();
    render(
      <RepositoryActionBar
        selectedRows={[row("a")]}
        knownTags={[]}
        onApplyTag={vi.fn()}
        onArchive={vi.fn()}
        onMoveToFolder={onMoveToFolder}
        onExportCsv={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("repository-action-move"));
    fireEvent.click(screen.getByTestId("repository-action-move-templates"));
    expect(onMoveToFolder).toHaveBeenCalledWith("Templates");
  });

  it("Cancel calls back", () => {
    const onCancel = vi.fn();
    render(
      <RepositoryActionBar
        selectedRows={[row("a")]}
        knownTags={[]}
        onApplyTag={vi.fn()}
        onArchive={vi.fn()}
        onMoveToFolder={vi.fn()}
        onExportCsv={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("repository-action-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});
