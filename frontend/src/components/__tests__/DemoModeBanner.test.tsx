import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import DemoModeBanner, {
  DEMO_BANNER_DISMISSED_KEY,
} from "../DemoModeBanner";

function renderBanner() {
  return render(
    <MemoryRouter>
      <DemoModeBanner />
    </MemoryRouter>,
  );
}

describe("DemoModeBanner", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("renders the full banner on a fresh session", () => {
    renderBanner();
    expect(screen.getByTestId("demo-mode-banner")).toBeInTheDocument();
    expect(screen.getByTestId("demo-banner-dismiss")).toBeInTheDocument();
  });

  it("dismiss persists to sessionStorage and removes the banner", () => {
    renderBanner();
    fireEvent.click(screen.getByTestId("demo-banner-dismiss"));
    expect(screen.queryByTestId("demo-mode-banner")).toBeNull();
    expect(window.sessionStorage.getItem(DEMO_BANNER_DISMISSED_KEY)).toBe(
      "true",
    );
  });

  it("renders nothing when sessionStorage already says dismissed", () => {
    window.sessionStorage.setItem(DEMO_BANNER_DISMISSED_KEY, "true");
    renderBanner();
    expect(screen.queryByTestId("demo-mode-banner")).toBeNull();
  });
});
