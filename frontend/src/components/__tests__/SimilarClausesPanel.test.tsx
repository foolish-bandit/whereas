import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import SimilarClausesPanel from "../SimilarClausesPanel";

describe("SimilarClausesPanel", () => {
  it("renders passed matches", () => {
    render(
      <SimilarClausesPanel
        sourceClauseTitle="Confidentiality"
        sourceClauseText="Each party keeps information confidential."
        matches={[
          {
            id: "1",
            title: "Approved NDA confidentiality",
            contract_type: "NDA",
            clause_type: "Confidentiality",
            similarity_label: "High",
            basis: "Similar carveout pattern.",
            approved_language_preview: "Confidential information excludes public data.",
            href: "/clause-manager?clause_id=1",
          },
        ]}
      />,
    );

    expect(screen.getByText(/approved nda confidentiality/i)).toBeInTheDocument();
    expect(screen.getByText(/demo preview/i)).toBeInTheDocument();
    expect(
      screen.getByText(/does not run embeddings or reranking/i),
    ).toBeInTheDocument();
  });

  it("renders planned empty state when matches are explicitly empty", () => {
    render(
      <SimilarClausesPanel
        sourceClauseTitle="Termination"
        sourceClauseText="Either party may terminate with notice."
        matches={[]}
      />,
    );

    expect(
      screen.getByText(/clause similarity is planned\. once embeddings are enabled/i),
    ).toBeInTheDocument();
  });

  it("renders clause manager links only when href is available", () => {
    render(
      <SimilarClausesPanel
        sourceClauseTitle="Governing Law"
        sourceClauseText="Delaware law applies."
        matches={[
          {
            id: "with-link",
            title: "Linked",
            contract_type: "MSA",
            clause_type: "Governing Law",
            similarity_label: "Medium",
            basis: "Comparable governing law structure.",
            approved_language_preview: "This agreement is governed by...",
            href: "/clause-manager?clause_id=with-link",
          },
          {
            id: "no-link",
            title: "Unlinked",
            contract_type: "SaaS",
            clause_type: "Governing Law",
            similarity_label: "Low",
            basis: "Different venue language.",
            approved_language_preview: "Venue shall be...",
            href: null,
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: /open in clause manager/i })).toHaveAttribute(
      "href",
      "/clause-manager?clause_id=with-link",
    );
    expect(screen.getByText(/no clause manager link available/i)).toBeInTheDocument();
  });
});
