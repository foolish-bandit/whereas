import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { clearDevUserId, setDevUserId } from "../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setupStandaloneMatchMedia(matches = true) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: matches && query === "(display-mode: standalone)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("PWA welcome routing", () => {
  beforeEach(() => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/api/setup/status")) {
        return jsonResponse({
          setup_required: true,
          organization_count: 0,
          user_count: 0,
          dev_mode_enabled: true,
          message: null,
        });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  }

  it("routes /demo to the app welcome page", async () => {
    renderAt("/demo");
    expect(await screen.findByTestId("pwa-welcome-page")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /welcome to whereas/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it("redirects standalone root traffic into the app welcome page", async () => {
    setupStandaloneMatchMedia();
    renderAt("/");
    expect(await screen.findByTestId("pwa-welcome-page")).toBeInTheDocument();
  });
});
