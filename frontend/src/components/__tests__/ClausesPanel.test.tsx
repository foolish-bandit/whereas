import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import ClausesPanel from "../ClausesPanel";
import type { Clause } from "../../types/contracts";

const FULL_TEXT =
  "1. Confidentiality. Each Party shall hold the other Party's Confidential Information in strict confidence.\n\n" +
  "2. Governing Law. This Agreement is governed by the laws of the State of Delaware.\n\n" +
  "3. Termination. Either Party may terminate on thirty days' written notice.\n";

function clauseAt(
  ordinal: number,
  needle: string,
  overrides: Partial<Clause> = {},
): Clause {
  const offset = FULL_TEXT.indexOf(needle);
  if (offset < 0) throw new Error(`needle not found: ${needle}`);
  return {
    id: `clause-${ordinal}`,
    contract_id: "contract-1",
    ordinal,
    heading: needle.split(".")[0] + ".",
    clause_type: null,
    clause_type_source: null,
    text: needle,
    span_start: offset,
    span_end: offset + needle.length,
    confidence: null,
    segmentation_method: "heuristic_v1",
    model_name: null,
    prompt_version: null,
    ...overrides,
  };
}

const CLAUSES: Clause[] = [
  clauseAt(
    0,
    "1. Confidentiality. Each Party shall hold the other Party's Confidential Information in strict confidence.",
    { clause_type: "confidentiality", clause_type_source: "heuristic" },
  ),
  clauseAt(
    1,
    "2. Governing Law. This Agreement is governed by the laws of the State of Delaware.",
    { clause_type: "governing_law", clause_type_source: "heuristic" },
  ),
  clauseAt(
    2,
    "3. Termination. Either Party may terminate on thirty days' written notice.",
    { clause_type: "termination", clause_type_source: "heuristic" },
  ),
];

describe("ClausesPanel", () => {
  afterEach(() => cleanup());

  it("renders an empty state when no clauses exist", () => {
    render(
      <ClausesPanel
        clauses={[]}
        fullText={FULL_TEXT}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByText(/no clauses have been segmented/i),
    ).toBeInTheDocument();
  });

  it("renders the count summary and a row per clause", () => {
    render(
      <ClausesPanel
        clauses={CLAUSES}
        fullText={FULL_TEXT}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/3 found/i)).toBeInTheDocument();
    expect(screen.getByText(/Confidentiality\./)).toBeInTheDocument();
    expect(screen.getByText(/Governing Law\./)).toBeInTheDocument();
    expect(screen.getByText(/Termination\./)).toBeInTheDocument();
  });

  it("calls onSelect with the clause selection key when a clause is clicked", () => {
    const onSelect = vi.fn();
    render(
      <ClausesPanel
        clauses={CLAUSES}
        fullText={FULL_TEXT}
        selectedKey={null}
        onSelect={onSelect}
      />,
    );
    const button = screen.getAllByRole("button")[0];
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith(`clause:${CLAUSES[0].id}`);
  });

  it("filters by clause_type", () => {
    render(
      <ClausesPanel
        clauses={CLAUSES}
        fullText={FULL_TEXT}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    const select = screen.getByLabelText(
      /filter clauses by type/i,
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "termination" } });
    // The summary updates to "Showing 1 of 3" and only the termination
    // clause's heading is in the document.
    expect(screen.getByText(/Showing 1 of 3/i)).toBeInTheDocument();
    expect(screen.queryByText(/Confidentiality\./)).not.toBeInTheDocument();
    expect(screen.getByText(/Termination\./)).toBeInTheDocument();
  });

  it("filters by search across heading and body", () => {
    render(
      <ClausesPanel
        clauses={CLAUSES}
        fullText={FULL_TEXT}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    const search = screen.getByLabelText(/search clauses/i);
    fireEvent.change(search, { target: { value: "delaware" } });
    expect(screen.getByText(/Governing Law\./)).toBeInTheDocument();
    expect(screen.queryByText(/Confidentiality\./)).not.toBeInTheDocument();
  });

  it("shows 'Citation unavailable' when offsets do not match the source", () => {
    const broken: Clause = clauseAt(
      0,
      "1. Confidentiality. Each Party shall hold the other Party's Confidential Information in strict confidence.",
    );
    render(
      <ClausesPanel
        clauses={[
          {
            ...broken,
            span_start: broken.span_start + 1, // shift by one → mismatch
          },
        ]}
        fullText={FULL_TEXT}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/citation unavailable/i)).toBeInTheDocument();
  });
});
