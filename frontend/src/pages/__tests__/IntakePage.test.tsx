import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import IntakePage from "../IntakePage";

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/demo/intake" element={<IntakePage />} />
        <Route path="/intake" element={<IntakePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("IntakePage", () => {
  it("renders the Intake heading and sub-copy", () => {
    renderAt("/demo/intake");
    expect(
      screen.getByRole("heading", { name: /intake/i, level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/start contract work from one guided front door/i),
    ).toBeInTheDocument();
  });

  it("renders all five action cards", () => {
    renderAt("/demo/intake");
    expect(screen.getByTestId("intake-card-upload")).toBeInTheDocument();
    expect(screen.getByTestId("intake-card-request")).toBeInTheDocument();
    expect(screen.getByTestId("intake-card-templates")).toBeInTheDocument();
    expect(screen.getByTestId("intake-card-inbox")).toBeInTheDocument();
    expect(screen.getByTestId("intake-card-approvals")).toBeInTheDocument();
  });

  it("links Upload card to /demo/upload when mounted under /demo", () => {
    renderAt("/demo/intake");
    expect(screen.getByTestId("intake-card-upload")).toHaveAttribute(
      "href",
      "/demo/upload",
    );
  });

  it("links Request card to /demo/requests#new-request when mounted under /demo", () => {
    renderAt("/demo/intake");
    expect(screen.getByTestId("intake-card-request")).toHaveAttribute(
      "href",
      "/demo/requests#new-request",
    );
  });

  it("links Templates card to /demo/requests/templates when mounted under /demo", () => {
    renderAt("/demo/intake");
    expect(screen.getByTestId("intake-card-templates")).toHaveAttribute(
      "href",
      "/demo/requests/templates",
    );
  });

  it("links Inbox card to /demo/inbox when mounted under /demo", () => {
    renderAt("/demo/intake");
    expect(screen.getByTestId("intake-card-inbox")).toHaveAttribute(
      "href",
      "/demo/inbox",
    );
  });

  it("links Approvals card to /demo/approvals/tasks when mounted under /demo", () => {
    renderAt("/demo/intake");
    expect(screen.getByTestId("intake-card-approvals")).toHaveAttribute(
      "href",
      "/demo/approvals/tasks",
    );
  });

  it("uses standalone paths when mounted outside /demo", () => {
    renderAt("/intake");
    expect(screen.getByTestId("intake-card-upload")).toHaveAttribute(
      "href",
      "/upload",
    );
    expect(screen.getByTestId("intake-card-request")).toHaveAttribute(
      "href",
      "/requests#new-request",
    );
    expect(screen.getByTestId("intake-card-templates")).toHaveAttribute(
      "href",
      "/requests/templates",
    );
    expect(screen.getByTestId("intake-card-inbox")).toHaveAttribute(
      "href",
      "/inbox",
    );
    expect(screen.getByTestId("intake-card-approvals")).toHaveAttribute(
      "href",
      "/approvals/tasks",
    );
  });

  it("renders CTA labels inside each card", () => {
    renderAt("/demo/intake");
    expect(screen.getByTestId("intake-card-upload-cta")).toHaveTextContent(
      /upload to repository/i,
    );
    expect(screen.getByTestId("intake-card-request-cta")).toHaveTextContent(
      /start request/i,
    );
    expect(screen.getByTestId("intake-card-templates-cta")).toHaveTextContent(
      /browse templates/i,
    );
    expect(screen.getByTestId("intake-card-inbox-cta")).toHaveTextContent(
      /open inbox/i,
    );
    expect(screen.getByTestId("intake-card-approvals-cta")).toHaveTextContent(
      /open approval tasks/i,
    );
  });
});
