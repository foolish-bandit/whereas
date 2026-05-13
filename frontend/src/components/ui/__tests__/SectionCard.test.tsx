import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SectionCard from "../SectionCard";

describe("SectionCard", () => {
  it("renders the title as an h2", () => {
    render(<SectionCard title="My Section">content</SectionCard>);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "My Section",
    );
  });

  it("renders children", () => {
    render(
      <SectionCard title="My Section">
        <p>Hello inside</p>
      </SectionCard>,
    );
    expect(screen.getByText("Hello inside")).toBeInTheDocument();
  });

  it("renders the description when provided", () => {
    render(
      <SectionCard title="My Section" description="Context note.">
        content
      </SectionCard>,
    );
    expect(screen.getByText("Context note.")).toBeInTheDocument();
  });

  it("renders the action slot", () => {
    render(
      <SectionCard
        title="My Section"
        action={<button type="button">Edit</button>}
      >
        content
      </SectionCard>,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("applies testId and id props", () => {
    render(
      <SectionCard title="My Section" testId="my-section" id="anchor">
        content
      </SectionCard>,
    );
    expect(screen.getByTestId("my-section")).toBeInTheDocument();
    expect(document.getElementById("anchor")).toBeInTheDocument();
  });
});
