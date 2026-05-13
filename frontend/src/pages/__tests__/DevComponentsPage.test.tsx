import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import DevComponentsPage from "../DevComponentsPage";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dev/components" element={<DevComponentsPage />} />
        <Route
          path="/demo/dashboard"
          element={<div data-testid="dashboard-stub" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const importEnv = import.meta.env as unknown as Record<string, unknown>;

describe("DevComponentsPage gating", () => {
  let originalDev: unknown;

  beforeEach(() => {
    originalDev = importEnv.DEV;
  });

  afterEach(() => {
    importEnv.DEV = originalDev;
  });

  it("renders the playground in dev mode regardless of the flag", () => {
    importEnv.DEV = true;
    renderAt("/dev/components");
    expect(screen.getByTestId("dev-components-page")).toBeInTheDocument();
  });

  it("redirects to the dashboard in production builds without ?dev=1", () => {
    importEnv.DEV = false;
    renderAt("/dev/components");
    expect(screen.queryByTestId("dev-components-page")).toBeNull();
    expect(screen.getByTestId("dashboard-stub")).toBeInTheDocument();
  });

  it("renders in production when ?dev=1 is present", () => {
    importEnv.DEV = false;
    renderAt("/dev/components?dev=1");
    expect(screen.getByTestId("dev-components-page")).toBeInTheDocument();
  });

  it("renders every component section heading", () => {
    importEnv.DEV = true;
    renderAt("/dev/components");
    for (const id of [
      "pill",
      "severity-tag",
      "status-badge",
      "kpi-tile",
      "trend-indicator",
      "metadata-row",
      "finding-card",
      "empty-tab-state",
    ]) {
      expect(
        screen.getByTestId(`dev-components-section-${id}`),
      ).toBeInTheDocument();
    }
  });
});

// Touch vi to keep eslint happy about unused-import detection in some
// configurations; the local rule doesn't care, but other linters do.
void vi;
