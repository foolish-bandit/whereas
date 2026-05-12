import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Header from "../Header";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderHeader() {
  return render(
    <MemoryRouter>
      <Header
        devUserId={DEV_USER}
        demoMode
        onOpenSidebar={() => {}}
      />
    </MemoryRouter>,
  );
}

describe("Header", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        counts: { overdue_approval_steps: 3 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("Cmd+K opens the command palette", async () => {
    renderHeader();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(
      await screen.findByTestId("command-palette"),
    ).toBeInTheDocument();
  });

  it("Ctrl+K also opens the command palette", async () => {
    renderHeader();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      await screen.findByTestId("command-palette"),
    ).toBeInTheDocument();
  });

  it("the search trigger opens the palette on click", async () => {
    renderHeader();
    fireEvent.click(screen.getByTestId("header-search-trigger"));
    expect(
      await screen.findByTestId("command-palette"),
    ).toBeInTheDocument();
  });

  it("the +New menu surfaces every required item", () => {
    renderHeader();
    fireEvent.click(screen.getByTestId("header-new-trigger"));
    for (const label of [
      "New request",
      "Upload to repository",
      "Start from template",
      "New playbook rule",
      "New clause",
    ]) {
      expect(
        screen.getByText(label, { selector: "button" }),
      ).toBeInTheDocument();
    }
  });

  it("the notification bell shows a badge with the overdue count", async () => {
    renderHeader();
    await waitFor(() =>
      expect(screen.getByTestId("header-bell-badge")).toHaveTextContent("3"),
    );
  });

  it("the user dropdown exposes Settings + Sign out", () => {
    renderHeader();
    fireEvent.click(screen.getByTestId("header-user-trigger"));
    expect(screen.getByTestId("header-user-settings")).toHaveAttribute(
      "href",
      "/demo/settings",
    );
    expect(screen.getByTestId("header-user-signout")).toBeInTheDocument();
  });
});
