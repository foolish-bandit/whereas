import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import FolderPicker from "../FolderPicker";

const mocks = vi.hoisted(() => ({
  listIntegrationFolders: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  listIntegrationFolders: mocks.listIntegrationFolders,
}));

interface FakeFolder {
  id: string;
  name: string;
  has_children: boolean;
  parent_id: string | null;
}

function tree(parentId: string | null, folders: FakeFolder[]) {
  return {
    parent_id: parentId ?? "root",
    folders,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof FolderPicker>> = {}) {
  const onCancel = vi.fn();
  const onPick = vi.fn().mockResolvedValue(undefined);
  const onClear = vi.fn().mockResolvedValue(undefined);
  render(
    <FolderPicker
      connectionId="ic-1"
      providerLabel="Google Drive"
      initialFolderId={null}
      initialFolderName={null}
      onCancel={onCancel}
      onPick={onPick}
      onClear={onClear}
      {...overrides}
    />,
  );
  return { onCancel, onPick, onClear };
}

describe("FolderPicker", () => {
  beforeEach(() => {
    mocks.listIntegrationFolders.mockReset();
  });

  it("loads the root level on open and renders the children", async () => {
    mocks.listIntegrationFolders.mockResolvedValueOnce(
      tree("root", [
        { id: "f1", name: "Sales", has_children: true, parent_id: "root" },
        { id: "f2", name: "Legal", has_children: false, parent_id: "root" },
      ]),
    );
    setup();
    await waitFor(() =>
      expect(mocks.listIntegrationFolders).toHaveBeenCalledWith("ic-1", {
        parent_id: "root",
      }),
    );
    expect(await screen.findByTestId("folder-picker-row-f1")).toHaveTextContent("Sales");
    expect(screen.getByTestId("folder-picker-row-f2")).toHaveTextContent("Legal");
  });

  it("navigates into a folder via the Open button and shows breadcrumbs", async () => {
    mocks.listIntegrationFolders
      .mockResolvedValueOnce(
        tree("root", [{ id: "f1", name: "Sales", has_children: true, parent_id: "root" }]),
      )
      .mockResolvedValueOnce(
        tree("f1", [
          { id: "f1a", name: "2026 Renewals", has_children: false, parent_id: "f1" },
        ]),
      );
    setup();
    fireEvent.click(await screen.findByTestId("folder-picker-open-f1"));
    expect(
      await screen.findByTestId("folder-picker-row-f1a"),
    ).toHaveTextContent("2026 Renewals");
    expect(screen.getByTestId("folder-picker-crumbs")).toHaveTextContent(
      /Google Drive.*Sales/,
    );
  });

  it("climbs back via a breadcrumb click", async () => {
    mocks.listIntegrationFolders
      .mockResolvedValueOnce(
        tree("root", [{ id: "f1", name: "Sales", has_children: true, parent_id: "root" }]),
      )
      .mockResolvedValueOnce(
        tree("f1", [
          { id: "f1a", name: "Renewals", has_children: false, parent_id: "f1" },
        ]),
      )
      .mockResolvedValueOnce(
        tree("root", [{ id: "f1", name: "Sales", has_children: true, parent_id: "root" }]),
      );
    setup();
    fireEvent.click(await screen.findByTestId("folder-picker-open-f1"));
    await screen.findByTestId("folder-picker-row-f1a");
    fireEvent.click(screen.getByTestId("folder-picker-crumb-0"));
    expect(await screen.findByTestId("folder-picker-row-f1")).toBeInTheDocument();
  });

  it("calls onPick with the selected folder path", async () => {
    mocks.listIntegrationFolders
      .mockResolvedValueOnce(
        tree("root", [{ id: "f1", name: "Sales", has_children: true, parent_id: "root" }]),
      )
      .mockResolvedValueOnce(
        tree("f1", [
          { id: "f1a", name: "Renewals", has_children: false, parent_id: "f1" },
        ]),
      );
    const { onPick } = setup();
    fireEvent.click(await screen.findByTestId("folder-picker-open-f1"));
    fireEvent.click(await screen.findByTestId("folder-picker-row-f1a"));
    fireEvent.click(screen.getByTestId("folder-picker-save"));
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith({
        id: "f1a",
        name: "Sales › Renewals",
        path: "Sales › Renewals",
      }),
    );
  });

  it("calls onClear when the user picks the synthetic root", async () => {
    mocks.listIntegrationFolders.mockResolvedValueOnce(tree("root", []));
    const { onClear } = setup();
    await screen.findByText(/No subfolders here/);
    fireEvent.click(screen.getByTestId("folder-picker-select-current"));
    expect(screen.getByTestId("folder-picker-selection")).toHaveTextContent(
      /Whole drive/,
    );
    fireEvent.click(screen.getByTestId("folder-picker-save"));
    await waitFor(() => expect(onClear).toHaveBeenCalled());
  });

  it("cancels when the user clicks the Cancel button", async () => {
    mocks.listIntegrationFolders.mockResolvedValueOnce(tree("root", []));
    const { onCancel } = setup();
    await screen.findByText(/No subfolders here/);
    fireEvent.click(screen.getByTestId("folder-picker-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("surfaces a folder-listing error in the modal without crashing", async () => {
    mocks.listIntegrationFolders.mockRejectedValueOnce(
      new Error("Nango proxy returned 500."),
    );
    setup();
    expect(
      await within(screen.getByTestId("folder-picker-list")).findByTestId(
        "folder-picker-error",
      ),
    ).toHaveTextContent(/Nango proxy returned 500/);
  });
});
