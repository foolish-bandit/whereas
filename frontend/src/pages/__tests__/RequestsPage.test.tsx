import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RequestsPage from "../RequestsPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const SAMPLE_REQUEST = {
  id: "req-1",
  organization_id: "org-1",
  title: "NDA with Acme",
  description: null,
  request_type: "new_contract",
  contract_type: "NDA",
  status: "open" as const,
  priority: "normal",
  requester_name: null,
  requester_email: null,
  counterparty_name: "Acme",
  due_date: "2026-06-01",
  assigned_to: null,
  linked_contract_id: null,
  linked_template_id: null,
  created_at: "2026-05-08T16:00:00Z",
  updated_at: "2026-05-08T16:00:00Z",
  created_by: null,
  metadata_json: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/requests"]}>
      <Routes>
        <Route path="/requests" element={<RequestsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequestsPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("renders an empty state when no requests exist", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage();
    expect(await screen.findByText(/No requests yet/i)).toBeInTheDocument();
  });

  it("renders the request list", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage();
    expect(await screen.findByText("NDA with Acme")).toBeInTheDocument();
    expect(screen.getByTestId("request-status").textContent).toBe("open");
    expect(screen.getByText(/Counterparty: Acme/)).toBeInTheDocument();
  });

  it("creates a request through the form", async () => {
    let listed = [SAMPLE_REQUEST];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/requests") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        const created = {
          ...SAMPLE_REQUEST,
          id: "req-2",
          title: body.title,
          contract_type: body.contract_type,
        };
        listed = [created, ...listed];
        return jsonResponse(created);
      }
      if (url.includes("/api/requests")) {
        return jsonResponse(listed);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");

    fireEvent.change(screen.getByPlaceholderText(/Title/i), {
      target: { value: "MSA renewal" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/Contract type/i),
      { target: { value: "MSA" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Create request/i }));

    expect(await screen.findByText("MSA renewal")).toBeInTheDocument();
  });

  it("marks a request in_progress via the Start button", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/api/requests/req-1") && init?.method === "PATCH") {
        return jsonResponse({ ...SAMPLE_REQUEST, status: "in_progress" });
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");

    fireEvent.click(screen.getByRole("button", { name: /Start/i }));

    await waitFor(() => {
      const row = screen.getByTestId("requests-row");
      expect(within(row).getByTestId("request-status").textContent).toBe(
        "in_progress",
      );
    });
  });

  it("hides cancelled requests by default and reveals them via toggle", async () => {
    const cancelled = { ...SAMPLE_REQUEST, id: "req-c", status: "cancelled" };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("include_cancelled=true")) {
        return jsonResponse([SAMPLE_REQUEST, cancelled]);
      }
      return jsonResponse([SAMPLE_REQUEST]);
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    expect(screen.getAllByTestId("requests-row")).toHaveLength(1);

    fireEvent.click(screen.getByLabelText(/Show cancelled/i));
    await waitFor(() => {
      expect(screen.getAllByTestId("requests-row")).toHaveLength(2);
    });
    const statuses = screen
      .getAllByTestId("request-status")
      .map((el) => el.textContent);
    expect(statuses).toContain("cancelled");
  });
});
