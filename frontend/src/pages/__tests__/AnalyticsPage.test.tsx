import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import AnalyticsPage from "../AnalyticsPage";

function renderPage(initialEntry = "/demo/analytics") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AnalyticsPage />
    </MemoryRouter>,
  );
}

describe("AnalyticsPage", () => {
  it("renders all five sections under the default 30-day range", () => {
    renderPage();
    for (const id of [
      "analytics-throughput",
      "analytics-cycle-time",
      "analytics-deviations",
      "analytics-type-breakdown",
      "analytics-bottlenecks",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it("the time-range picker swaps to All time and back", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("analytics-range-all"));
    expect(screen.getByTestId("analytics-range-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByTestId("analytics-range-7d"));
    expect(screen.getByTestId("analytics-range-7d")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("hydrates from ?range= URL", () => {
    renderPage("/demo/analytics?range=90d");
    expect(screen.getByTestId("analytics-range-90d")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("approval bottlenecks table is sorted descending by avg hours", () => {
    renderPage();
    const rows = screen.getAllByRole("row");
    // Skip header row; collect first numeric column from each data row.
    const dataRows = rows.slice(1);
    const avgs = dataRows.map((r) => {
      const cells = r.querySelectorAll("td");
      const t = cells[1]?.textContent?.trim() ?? "0";
      return parseInt(t, 10);
    });
    for (let i = 1; i < avgs.length; i += 1) {
      expect(avgs[i - 1]).toBeGreaterThanOrEqual(avgs[i]);
    }
  });
});
