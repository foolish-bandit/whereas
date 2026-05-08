import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../markdown";

function renderText(source: string) {
  return render(<div data-testid="root">{renderMarkdown(source)}</div>);
}

describe("renderMarkdown", () => {
  it("renders headings, paragraphs, and inline emphasis", () => {
    renderText("# Title\n\nA **bold** word and *italic* one.\n");
    expect(
      screen.getByRole("heading", { level: 1, name: "Title" }),
    ).toBeInTheDocument();
    expect(screen.getByText("bold").tagName.toLowerCase()).toBe("strong");
    expect(screen.getByText("italic").tagName.toLowerCase()).toBe("em");
  });

  it("renders unordered and ordered lists", () => {
    renderText("- one\n- two\n\n1. alpha\n2. beta\n");
    const uls = document.querySelectorAll("ul");
    const ols = document.querySelectorAll("ol");
    expect(uls.length).toBe(1);
    expect(ols.length).toBe(1);
    expect(uls[0].querySelectorAll("li").length).toBe(2);
    expect(ols[0].querySelectorAll("li").length).toBe(2);
  });

  it("renders fenced code blocks verbatim", () => {
    renderText("```\nhello **not bold**\n```\n");
    const pre = document.querySelector("pre code");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("**not bold**");
  });

  it("renders blockquotes and horizontal rules", () => {
    renderText("> a quoted line\n\n---\n");
    expect(document.querySelector("blockquote")).not.toBeNull();
    expect(document.querySelector("hr")).not.toBeNull();
  });

  it("renders inline code", () => {
    renderText("Use `npm test` to run.\n");
    const code = document.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("npm test");
  });

  it("renders links and rejects unsafe schemes", () => {
    renderText(
      "Safe [link](https://example.com) and [evil](javascript:alert(1)).\n",
    );
    const links = Array.from(document.querySelectorAll("a"));
    // Only the safe link is rendered as <a>; the unsafe one falls back
    // to plain text (no anchor element).
    expect(links.length).toBe(1);
    expect(links[0].getAttribute("href")).toBe("https://example.com");
    expect(links[0].getAttribute("rel")).toContain("noopener");
    // The unsafe label still appears as readable text.
    expect(screen.getByText("evil")).toBeInTheDocument();
  });

  it("does not interpret raw HTML — angle brackets are rendered as text", () => {
    renderText("Hello <script>alert(1)</script> world.\n");
    // No script tag should be present in the rendered DOM.
    expect(document.querySelector("script")).toBeNull();
    // The literal angle-bracket text is rendered.
    expect(screen.getByTestId("root").textContent).toContain(
      "<script>alert(1)</script>",
    );
  });

  it("handles \\r\\n line endings the same as \\n", () => {
    renderText("# Heading\r\n\r\nBody.\r\n");
    expect(
      screen.getByRole("heading", { level: 1, name: "Heading" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Body.")).toBeInTheDocument();
  });
});
