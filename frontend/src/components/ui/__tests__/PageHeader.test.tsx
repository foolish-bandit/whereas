import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PageHeader from "../PageHeader";

describe("PageHeader", () => {
  it("renders the title", () => {
    render(<PageHeader title="My Page" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "My Page",
    );
  });

  it("renders the description when provided", () => {
    render(<PageHeader title="My Page" description="A helpful description." />);
    expect(screen.getByText("A helpful description.")).toBeInTheDocument();
  });

  it("omits the description element when not provided", () => {
    render(<PageHeader title="My Page" />);
    expect(screen.queryByRole("paragraph")).toBeNull();
  });

  it("renders the eyebrow slot", () => {
    render(
      <PageHeader
        title="My Page"
        eyebrow={<span data-testid="eyebrow">Breadcrumb</span>}
      />,
    );
    expect(screen.getByTestId("eyebrow")).toBeInTheDocument();
  });

  it("renders the actions slot", () => {
    render(
      <PageHeader
        title="My Page"
        actions={<button type="button">Save</button>}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Save" }),
    ).toBeInTheDocument();
  });

  it("omits the actions wrapper when no actions provided", () => {
    const { container } = render(<PageHeader title="My Page" />);
    // Only one child div (the title block); no sibling for the actions slot.
    const outerDiv = container.firstElementChild!;
    expect(outerDiv.children).toHaveLength(1);
  });
});
