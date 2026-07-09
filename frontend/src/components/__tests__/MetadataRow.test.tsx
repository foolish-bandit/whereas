import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import MetadataRow from "../MetadataRow";
import type { ExtractedField } from "../../types/contracts";

function field(overrides: Partial<ExtractedField> = {}): ExtractedField {
  return {
    field_name: "governing_law",
    value_json: "New York",
    span_start: 100,
    span_end: 110,
    span_text: "New York",
    confidence: 0.96,
    model_name: "llama3.1:8b",
    prompt_version: "v1",
    extracted_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("MetadataRow", () => {
  it("renders the value, the high-confidence pill, and a jump-to-source button", () => {
    render(
      <MetadataRow
        field={field()}
        isSelected={false}
        onJumpToSource={vi.fn()}
      />,
    );
    expect(screen.getByText("New York")).toBeInTheDocument();
    expect(screen.getByTestId(/metadata-row-confidence-/)).toHaveTextContent(
      /high/i,
    );
    expect(screen.getByTestId(/metadata-row-confidence-/)).toHaveTextContent(
      /96%/,
    );
    expect(
      screen.getByTestId(/metadata-row-jump-/),
    ).toHaveTextContent(/jump to source/i);
  });

  it("uses a warning-toned medium badge for 50–79% confidence", () => {
    render(
      <MetadataRow
        field={field({ confidence: 0.74 })}
        isSelected={false}
        onJumpToSource={vi.fn()}
      />,
    );
    const badge = screen.getByTestId(/metadata-row-confidence-/);
    expect(badge.className).toContain("warning");
    expect(badge).toHaveTextContent(/medium/i);
  });

  it("uses a danger-toned low badge for <50% confidence", () => {
    render(
      <MetadataRow
        field={field({ confidence: 0.42 })}
        isSelected={false}
        onJumpToSource={vi.fn()}
      />,
    );
    const badge = screen.getByTestId(/metadata-row-confidence-/);
    expect(badge.className).toContain("danger");
    expect(badge).toHaveTextContent(/low/i);
  });

  it("hides the confidence pill and shows 'Manually set' when an override exists", () => {
    render(
      <MetadataRow
        field={field()}
        isSelected={false}
        onJumpToSource={vi.fn()}
        override={{ value: "Delaware" }}
        onSaveOverride={vi.fn()}
        onClearOverride={vi.fn()}
      />,
    );
    expect(screen.getByText("Delaware")).toBeInTheDocument();
    expect(
      screen.getByTestId(/metadata-row-manual-/),
    ).toHaveTextContent(/manually set/i);
    expect(
      screen.queryByTestId(/metadata-row-confidence-/),
    ).not.toBeInTheDocument();
  });

  it("Edit → Save commits a new override via onSaveOverride", () => {
    const onSave = vi.fn();
    render(
      <MetadataRow
        field={field()}
        isSelected={false}
        onJumpToSource={vi.fn()}
        onSaveOverride={onSave}
      />,
    );
    fireEvent.click(screen.getByTestId(/metadata-row-edit-/));
    const input = screen.getByTestId(/metadata-row-input-/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "California" } });
    fireEvent.click(screen.getByTestId(/metadata-row-save-/));
    expect(onSave).toHaveBeenCalledWith(expect.any(String), "California");
  });

  it("exposes a tooltip with the citation excerpt next to the jump button", () => {
    const long =
      "The parties agree that this Agreement shall be governed by and construed in accordance with the laws of the State of New York and any disputes will be resolved in courts of competent jurisdiction in New York County, NY.";
    render(
      <MetadataRow
        field={field({ span_text: long })}
        isSelected={false}
        onJumpToSource={vi.fn()}
      />,
    );
    const tooltip = screen.getByTestId(/metadata-row-tooltip-/);
    expect(tooltip.getAttribute("role")).toBe("tooltip");
    // Trimmed to 200 chars + ellipsis.
    expect(tooltip.textContent ?? "").toMatch(/…/);
    expect((tooltip.textContent ?? "").length).toBeLessThan(long.length + 10);
  });

  it("renders 'Citation unavailable' when the field has no valid span", () => {
    render(
      <MetadataRow
        field={field({ span_start: null, span_end: null, span_text: null })}
        isSelected={false}
        onJumpToSource={vi.fn()}
      />,
    );
    expect(screen.getByText(/citation unavailable/i)).toBeInTheDocument();
    expect(
      screen.queryByTestId(/metadata-row-jump-/),
    ).not.toBeInTheDocument();
  });
});
