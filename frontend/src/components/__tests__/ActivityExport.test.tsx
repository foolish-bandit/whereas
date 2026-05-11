import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ActivityExport from "../ActivityExport";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

function csvResponse(body: string, filename = "export.csv"): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="export.json"',
    },
  });
}

describe("ActivityExport", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let createUrl: ReturnType<typeof vi.fn>;
  let revokeUrl: ReturnType<typeof vi.fn>;
  let anchorClicks: HTMLAnchorElement[];

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);

    createUrl = vi.fn(() => "blob:mock-url");
    revokeUrl = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createUrl,
      revokeObjectURL: revokeUrl,
    });

    anchorClicks = [];
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      (tag: string, opts?: ElementCreationOptions) => {
        const el = realCreateElement(tag, opts);
        if (tag === "a") {
          const anchor = el as HTMLAnchorElement;
          const realClick = anchor.click.bind(anchor);
          anchor.click = () => {
            anchorClicks.push(anchor);
            realClick();
          };
        }
        return el;
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearDevUserId();
  });

  it("renders both export affordances", () => {
    render(<ActivityExport kind="contract" contractId="c-1" />);
    expect(screen.getByTestId("activity-export-label")).toHaveTextContent(
      /export activity/i,
    );
    expect(screen.getByTestId("activity-export-csv")).toBeInTheDocument();
    expect(screen.getByTestId("activity-export-json")).toBeInTheDocument();
  });

  it("calls the contract CSV export endpoint and triggers a blob download", async () => {
    const csv = "occurred_at,event_type\n2026-05-01T00:00:00Z,contract.executed\n";
    fetchMock.mockResolvedValue(csvResponse(csv, "contract-c-1-activity.csv"));

    render(<ActivityExport kind="contract" contractId="c-1" />);
    fireEvent.click(screen.getByTestId("activity-export-csv"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/contracts/c-1/activity/export");
    expect(url).toContain("format=csv");

    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    const anchor = anchorClicks[0];
    expect(anchor.download).toBe("contract-c-1-activity.csv");
    expect(anchor.href).toContain("blob:");
    expect(revokeUrl).toHaveBeenCalledTimes(1);
  });

  it("calls the request JSON export endpoint and triggers a download", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        export_type: "activity_timeline",
        generated_at: "2026-05-11T00:00:00Z",
        subject_type: "request",
        subject_id: "req-1",
        events: [],
      }),
    );

    render(<ActivityExport kind="request" requestId="req-1" />);
    fireEvent.click(screen.getByTestId("activity-export-json"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/requests/req-1/activity/export");
    expect(url).toContain("format=json");
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
  });

  it("renders a safe error state when the API responds with an error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "nope" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<ActivityExport kind="contract" contractId="c-1" />);
    fireEvent.click(screen.getByTestId("activity-export-csv"));

    await waitFor(() =>
      expect(screen.getByTestId("activity-export-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("activity-export-error")).toHaveTextContent(
      /nope|server/i,
    );
    expect(anchorClicks).toHaveLength(0);
  });

  it("does not render raw storage internals in the DOM", async () => {
    // Even if the backend regressed and returned bytes containing
    // forbidden terms, the component must not put them into rendered
    // markup. The bytes flow into a Blob/anchor, never into text.
    const leaky =
      "occurred_at,event_type\n2026-05-01,storage_key:secret,wrapped_dek:AAAA\n";
    fetchMock.mockResolvedValue(csvResponse(leaky));

    render(<ActivityExport kind="contract" contractId="c-1" />);
    fireEvent.click(screen.getByTestId("activity-export-csv"));
    await waitFor(() => expect(anchorClicks).toHaveLength(1));

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("storage_key");
    expect(text).not.toContain("wrapped_dek");
    expect(text).not.toContain("s3_key");
  });
});
