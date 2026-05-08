import { render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import MarkdownPreview from "../MarkdownPreview";
import { setDevUserId, clearDevUserId } from "../../lib/devUser";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const CONTRACT_ID = "22222222-2222-4222-8222-222222222222";

describe("MarkdownPreview", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(VALID_UUID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearDevUserId();
  });

  it("renders the markdown body when a snapshot is returned", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "33333333-3333-4333-8333-333333333333",
          contract_id: CONTRACT_ID,
          markdown_text: "# Demo\n\nBody paragraph.\n",
          source_kind: "original_upload",
          converter_name: "markitdown",
          converter_version: "0.0.1",
          conversion_status: "ready",
          conversion_warnings: null,
          created_at: "2026-05-08T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<MarkdownPreview contractId={CONTRACT_ID} />);

    expect(
      screen.getByRole("heading", { name: /markdown preview/i, level: 2 }),
    ).toBeInTheDocument();

    const heading = await screen.findByRole("heading", {
      name: "Demo",
      level: 1,
    });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText("Body paragraph.")).toBeInTheDocument();

    // Conversion metadata is exposed.
    expect(screen.getByTestId("markdown-meta").textContent).toMatch(
      /markitdown/i,
    );
    expect(screen.getByTestId("markdown-meta").textContent).toMatch(
      /0\.0\.1/,
    );
    // No warning panel for a clean conversion.
    expect(screen.queryByTestId("markdown-warnings")).toBeNull();
  });

  it("renders the empty state when the endpoint reports no snapshot", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Markdown snapshot not found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<MarkdownPreview contractId={CONTRACT_ID} />);

    const empty = await screen.findByTestId("markdown-empty-state");
    expect(empty.textContent).toMatch(/no markdown preview is available/i);
    // It also tells the user the original is still downloadable.
    expect(empty.textContent).toMatch(/original file.*downloadable/i);
    expect(screen.queryByTestId("markdown-body")).toBeNull();
  });

  it("displays conversion warnings when present", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "44444444-4444-4444-8444-444444444444",
          contract_id: CONTRACT_ID,
          markdown_text: "Plain body.\n",
          source_kind: "original_upload",
          converter_name: "fallback_plain_text",
          converter_version: null,
          conversion_status: "ready",
          conversion_warnings: ["markitdown_empty_output"],
          created_at: "2026-05-08T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<MarkdownPreview contractId={CONTRACT_ID} />);

    const warnings = await screen.findByTestId("markdown-warnings");
    expect(warnings.textContent).toMatch(/markitdown_empty_output/);
    // Converter name is also visible.
    expect(screen.getByTestId("markdown-meta").textContent).toMatch(
      /fallback_plain_text/,
    );
  });

  it("surfaces non-404 errors", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<MarkdownPreview contractId={CONTRACT_ID} />);
    await waitFor(() => {
      expect(screen.getByText(/boom/)).toBeInTheDocument();
    });
  });

  it("renders the right slot in the header (e.g. view-original action)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(
      <MarkdownPreview
        contractId={CONTRACT_ID}
        rightSlot={<button type="button">View original</button>}
      />,
    );
    expect(
      screen.getByRole("button", { name: /view original/i }),
    ).toBeInTheDocument();
  });
});
