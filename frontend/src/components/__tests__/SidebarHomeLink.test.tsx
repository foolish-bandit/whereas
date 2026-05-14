import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Sidebar from "../Sidebar";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Sidebar app home link", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          counts: { overdue_approval_steps: 0 },
        }),
      ),
    );
    setDevUserId(DEV_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("keeps the product logo inside the app shell", () => {
    render(
      <MemoryRouter>
        <Sidebar isOpen={false} onClose={() => {}} />
      </MemoryRouter>,
    );
    const homeLinks = screen.getAllByRole("link", { name: "Whereas app home" });
    expect(homeLinks.length).toBeGreaterThan(0);
    for (const link of homeLinks) {
      expect(link).toHaveAttribute("href", "/demo/welcome");
    }
  });
});
