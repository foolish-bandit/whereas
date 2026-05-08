import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import BrowserCapabilitiesCard from "../BrowserCapabilitiesCard";

describe("BrowserCapabilitiesCard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the capability list with explanatory copy", () => {
    render(<BrowserCapabilitiesCard />);

    expect(
      screen.getByRole("heading", {
        name: /pwa.*local browser capabilities/i,
      }),
    ).toBeInTheDocument();
    // Explanatory copy must mention that previews don't repeatedly
    // prompt for filesystem permissions.
    expect(
      screen.getByText(
        /does not require repeated file permission prompts/i,
      ),
    ).toBeInTheDocument();
    // Each capability row is rendered. Some capability descriptions
    // also mention these phrases; assert at least one node matches.
    expect(screen.getAllByText(/service worker/i).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/persistent storage/i).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/file picker access/i).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/origin private file system/i).length,
    ).toBeGreaterThan(0);
  });
});
