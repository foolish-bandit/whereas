import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import IntegrationsPage from "../IntegrationsPage";
import type {
  IntegrationConnection,
  IntegrationProvider,
} from "../../types/integrations";

const mocks = vi.hoisted(() => {
  class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  }
  return {
    FakeApiError,
    listIntegrationProviders: vi.fn(),
    listIntegrationConnections: vi.fn(),
    createIntegrationConnectSession: vi.fn(),
    upsertIntegrationConnection: vi.fn(),
    updateIntegrationConnection: vi.fn(),
    deleteIntegrationConnection: vi.fn(),
    triggerIntegrationSync: vi.fn(),
    listIntegrationFolders: vi.fn(),
    openNangoConnect: vi.fn(),
  };
});

vi.mock("../../lib/api", () => ({
  ApiError: mocks.FakeApiError,
  listIntegrationProviders: mocks.listIntegrationProviders,
  listIntegrationConnections: mocks.listIntegrationConnections,
  createIntegrationConnectSession: mocks.createIntegrationConnectSession,
  upsertIntegrationConnection: mocks.upsertIntegrationConnection,
  updateIntegrationConnection: mocks.updateIntegrationConnection,
  deleteIntegrationConnection: mocks.deleteIntegrationConnection,
  triggerIntegrationSync: mocks.triggerIntegrationSync,
  listIntegrationFolders: mocks.listIntegrationFolders,
}));

vi.mock("../../lib/nangoConnect", () => ({
  openNangoConnect: mocks.openNangoConnect,
}));

const PROVIDERS: IntegrationProvider[] = [
  {
    key: "google-drive",
    label: "Google Drive",
    description: "Import contracts from a connected Google Drive folder.",
    available: true,
  },
  {
    key: "microsoft-onedrive",
    label: "Microsoft OneDrive",
    description: "Import contracts from a connected OneDrive folder.",
    available: true,
  },
  {
    key: "gmail",
    label: "Gmail",
    description: "Ingest contracts attached to incoming Gmail messages.",
    available: false,
  },
  {
    key: "outlook",
    label: "Microsoft Outlook",
    description: "Ingest contracts attached to incoming Outlook messages.",
    available: false,
  },
  {
    key: "microsoft-sharepoint",
    label: "Microsoft SharePoint",
    description: "Import contracts from a connected SharePoint document library.",
    available: false,
  },
];

const CONNECTED_DRIVE: IntegrationConnection = {
  id: "ic-1",
  organization_id: "org-1",
  provider: "google-drive",
  status: "active",
  ingest_mode: "inbox_review",
  display_name: "Sales Drive",
  last_synced_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  last_sync_error: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by: "user-1",
  root_folder_id: null,
  root_folder_name: null,
};

function renderPage() {
  render(
    <MemoryRouter>
      <IntegrationsPage />
    </MemoryRouter>,
  );
}

describe("IntegrationsPage", () => {
  beforeEach(() => {
    mocks.listIntegrationProviders.mockReset();
    mocks.listIntegrationConnections.mockReset();
    mocks.createIntegrationConnectSession.mockReset();
    mocks.upsertIntegrationConnection.mockReset();
    mocks.updateIntegrationConnection.mockReset();
    mocks.deleteIntegrationConnection.mockReset();
    mocks.triggerIntegrationSync.mockReset();
    mocks.listIntegrationFolders.mockReset();
    mocks.openNangoConnect.mockReset();
    mocks.listIntegrationProviders.mockResolvedValue(PROVIDERS);
    mocks.listIntegrationConnections.mockResolvedValue([]);
  });

  it("renders the page root and Active integrations section", async () => {
    renderPage();
    expect(screen.getByTestId("integrations-page")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("integrations-live-section")).toBeInTheDocument(),
    );
  });

  it("renders DocuSeal as a configured, always-on live card", async () => {
    renderPage();
    const card = await screen.findByTestId("integration-card-docuseal");
    expect(within(card).getByTestId("integration-status-docuseal")).toHaveTextContent(
      /Configured/i,
    );
    const cta = within(card).getByTestId("integration-cta-docuseal");
    expect(cta).toHaveAttribute("target", "_blank");
  });

  it("shows available providers with a Connect button and disabled providers with a configure-Nango hint", async () => {
    renderPage();
    const drive = await screen.findByTestId("integration-card-google-drive");
    expect(within(drive).getByTestId("integration-status-google-drive")).toHaveTextContent(
      /Not connected/i,
    );
    expect(within(drive).getByTestId("integration-cta-google-drive")).toHaveTextContent(
      /^Connect$/,
    );
    const gmail = await screen.findByTestId("integration-card-gmail");
    expect(within(gmail).getByTestId("integration-status-gmail")).toHaveTextContent(
      /Not configured/i,
    );
    expect(within(gmail).getByTestId("integration-cta-gmail")).toBeDisabled();
    expect(within(gmail).getByTestId("integration-caveat-gmail")).toHaveTextContent(
      /NANGO_ENABLED_PROVIDERS/,
    );
  });

  it("connects a provider through the Nango Connect handshake and surfaces the connected state", async () => {
    mocks.createIntegrationConnectSession.mockResolvedValue({
      token: "session-token",
      expires_at: null,
    });
    mocks.openNangoConnect.mockResolvedValue({
      kind: "connected",
      connectionId: "nango-conn-abc",
    });
    mocks.upsertIntegrationConnection.mockResolvedValue(CONNECTED_DRIVE);
    renderPage();
    const drive = await screen.findByTestId("integration-card-google-drive");
    fireEvent.click(within(drive).getByTestId("integration-cta-google-drive"));
    await waitFor(() =>
      expect(mocks.upsertIntegrationConnection).toHaveBeenCalledWith({
        provider: "google-drive",
        nango_connection_id: "nango-conn-abc",
      }),
    );
    expect(
      within(await screen.findByTestId("integration-card-google-drive")).getByTestId(
        "integration-status-google-drive",
      ),
    ).toHaveTextContent(/Connected/i);
    expect(screen.getByTestId("integrations-banner")).toHaveTextContent(/connected/i);
  });

  it("surfaces a cancelled Connect handshake as a non-error banner", async () => {
    mocks.createIntegrationConnectSession.mockResolvedValue({
      token: "session-token",
      expires_at: null,
    });
    mocks.openNangoConnect.mockResolvedValue({ kind: "cancelled" });
    renderPage();
    const drive = await screen.findByTestId("integration-card-google-drive");
    fireEvent.click(within(drive).getByTestId("integration-cta-google-drive"));
    await waitFor(() =>
      expect(screen.getByTestId("integrations-banner")).toHaveTextContent(/Cancelled/i),
    );
    expect(mocks.upsertIntegrationConnection).not.toHaveBeenCalled();
  });

  it("triggers a sync and reports the result count", async () => {
    mocks.listIntegrationConnections.mockResolvedValue([CONNECTED_DRIVE]);
    mocks.triggerIntegrationSync.mockResolvedValue({
      connection_id: CONNECTED_DRIVE.id,
      files_seen: 5,
      contracts_created: 2,
      skipped: 3,
      cursor: null,
    });
    renderPage();
    const drive = await screen.findByTestId("integration-card-google-drive");
    fireEvent.click(within(drive).getByTestId("integration-sync-google-drive"));
    await waitFor(() =>
      expect(mocks.triggerIntegrationSync).toHaveBeenCalledWith(CONNECTED_DRIVE.id),
    );
    expect(screen.getByTestId("integrations-banner")).toHaveTextContent(
      /2 new, 3 skipped/,
    );
  });

  it("does not disconnect when the user declines the confirm prompt", async () => {
    mocks.listIntegrationConnections.mockResolvedValue([CONNECTED_DRIVE]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    const drive = await screen.findByTestId("integration-card-google-drive");
    fireEvent.click(within(drive).getByTestId("integration-disconnect-google-drive"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(mocks.deleteIntegrationConnection).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("disconnects when the user confirms", async () => {
    mocks.listIntegrationConnections.mockResolvedValue([CONNECTED_DRIVE]);
    mocks.deleteIntegrationConnection.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    const drive = await screen.findByTestId("integration-card-google-drive");
    fireEvent.click(within(drive).getByTestId("integration-disconnect-google-drive"));
    await waitFor(() =>
      expect(mocks.deleteIntegrationConnection).toHaveBeenCalledWith(
        CONNECTED_DRIVE.id,
      ),
    );
    confirmSpy.mockRestore();
  });

  it("updates ingest mode through the dropdown", async () => {
    mocks.listIntegrationConnections.mockResolvedValue([CONNECTED_DRIVE]);
    mocks.updateIntegrationConnection.mockResolvedValue({
      ...CONNECTED_DRIVE,
      ingest_mode: "direct",
    });
    renderPage();
    const select = await screen.findByTestId("integration-ingest-mode-google-drive");
    fireEvent.change(select, { target: { value: "direct" } });
    await waitFor(() =>
      expect(mocks.updateIntegrationConnection).toHaveBeenCalledWith(
        CONNECTED_DRIVE.id,
        { ingest_mode: "direct" },
      ),
    );
  });

  it("renders the roadmap section with all planned non-Nango integrations", async () => {
    renderPage();
    await screen.findByTestId("integration-card-google-drive");
    const roadmap = screen.getByTestId("integrations-roadmap-section");
    const plannedSlugs = [
      "microsoft-word",
      "google-docs",
      "slack",
      "microsoft-teams",
      "salesforce",
      "hubspot",
      "local-model-providers",
    ];
    for (const slug of plannedSlugs) {
      expect(within(roadmap).getByTestId(`integration-card-${slug}`)).toBeInTheDocument();
      expect(within(roadmap).getByTestId(`integration-status-${slug}`)).toHaveTextContent(
        /Planned/i,
      );
    }
  });

  it("does not leak Nango secrets into the rendered DOM", async () => {
    mocks.listIntegrationConnections.mockResolvedValue([CONNECTED_DRIVE]);
    renderPage();
    await screen.findByTestId("integration-card-google-drive");
    const text = document.body.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("session-token");
    expect(text.toLowerCase()).not.toContain("nango_secret_key");
    expect(text.toLowerCase()).not.toContain("nango_webhook_secret");
  });

  it("shows 'Whole drive' on a connected Drive card when no folder is set", async () => {
    mocks.listIntegrationConnections.mockResolvedValue([CONNECTED_DRIVE]);
    renderPage();
    const folder = await screen.findByTestId("integration-folder-google-drive");
    expect(
      within(folder).getByTestId("integration-folder-name-google-drive"),
    ).toHaveTextContent(/Whole drive/);
  });

  it("shows the picked folder name on a scoped Drive card", async () => {
    mocks.listIntegrationConnections.mockResolvedValue([
      {
        ...CONNECTED_DRIVE,
        root_folder_id: "folder-x",
        root_folder_name: "Sales › Renewals",
      },
    ]);
    renderPage();
    const folder = await screen.findByTestId("integration-folder-google-drive");
    expect(
      within(folder).getByTestId("integration-folder-name-google-drive"),
    ).toHaveTextContent("Sales › Renewals");
  });

  it("does not render the folder picker block for Gmail (no folder concept)", async () => {
    // Use a Gmail-only fixture so the page renders a Gmail connection
    // and we can assert the folder block is absent.
    const gmailConnection = {
      ...CONNECTED_DRIVE,
      id: "ic-gm",
      provider: "gmail",
      root_folder_id: null,
      root_folder_name: null,
    };
    mocks.listIntegrationConnections.mockResolvedValue([gmailConnection]);
    renderPage();
    await screen.findByTestId("integration-card-gmail");
    expect(screen.queryByTestId("integration-folder-gmail")).toBeNull();
  });

  it("opens the folder picker after a successful Drive Connect", async () => {
    mocks.createIntegrationConnectSession.mockResolvedValue({
      token: "session-token",
      expires_at: null,
    });
    mocks.openNangoConnect.mockResolvedValue({
      kind: "connected",
      connectionId: "nango-conn-abc",
    });
    mocks.upsertIntegrationConnection.mockResolvedValue(CONNECTED_DRIVE);
    mocks.listIntegrationFolders.mockResolvedValue({
      parent_id: "root",
      folders: [],
    });
    renderPage();
    const drive = await screen.findByTestId("integration-card-google-drive");
    fireEvent.click(within(drive).getByTestId("integration-cta-google-drive"));
    expect(await screen.findByTestId("folder-picker")).toBeInTheDocument();
  });

  it("opens the picker from the Change link and patches the connection on save", async () => {
    mocks.listIntegrationConnections.mockResolvedValue([CONNECTED_DRIVE]);
    mocks.listIntegrationFolders.mockResolvedValue({
      parent_id: "root",
      folders: [
        {
          id: "folder-sales",
          name: "Sales",
          has_children: false,
          parent_id: "root",
        },
      ],
    });
    mocks.updateIntegrationConnection.mockResolvedValue({
      ...CONNECTED_DRIVE,
      root_folder_id: "folder-sales",
      root_folder_name: "Sales",
    });
    renderPage();
    fireEvent.click(
      await screen.findByTestId("integration-folder-edit-google-drive"),
    );
    expect(await screen.findByTestId("folder-picker")).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId("folder-picker-row-folder-sales"));
    fireEvent.click(screen.getByTestId("folder-picker-save"));
    await waitFor(() =>
      expect(mocks.updateIntegrationConnection).toHaveBeenCalledWith(
        CONNECTED_DRIVE.id,
        { root_folder_id: "folder-sales", root_folder_name: "Sales" },
      ),
    );
    // Modal closes on successful save.
    await waitFor(() =>
      expect(screen.queryByTestId("folder-picker")).toBeNull(),
    );
  });

  it("clears the folder scope when the user picks the synthetic root", async () => {
    mocks.listIntegrationConnections.mockResolvedValue([
      {
        ...CONNECTED_DRIVE,
        root_folder_id: "folder-x",
        root_folder_name: "Sales",
      },
    ]);
    mocks.listIntegrationFolders.mockResolvedValue({
      parent_id: "root",
      folders: [],
    });
    mocks.updateIntegrationConnection.mockResolvedValue({
      ...CONNECTED_DRIVE,
      root_folder_id: null,
      root_folder_name: null,
    });
    renderPage();
    fireEvent.click(
      await screen.findByTestId("integration-folder-edit-google-drive"),
    );
    await screen.findByTestId("folder-picker");
    fireEvent.click(screen.getByTestId("folder-picker-select-current"));
    fireEvent.click(screen.getByTestId("folder-picker-save"));
    await waitFor(() =>
      expect(mocks.updateIntegrationConnection).toHaveBeenCalledWith(
        CONNECTED_DRIVE.id,
        { root_folder_id: "" },
      ),
    );
  });
});
