import { describe, expect, it } from "vitest";

import {
  composeDescription,
  getQuestionSetFor,
  summarizeAnswers,
} from "../supportingQuestions";

describe("supportingQuestions", () => {
  describe("getQuestionSetFor", () => {
    it("returns null when both request_type and contract_type are empty", () => {
      expect(getQuestionSetFor(null, null)).toBeNull();
      expect(getQuestionSetFor("", "")).toBeNull();
    });

    it("matches NDA via request_type=nda_review", () => {
      expect(getQuestionSetFor("nda_review", null)?.key).toBe("nda");
    });

    it("matches NDA via free-text contract_type 'NDA' or slug 'mutual_nda'", () => {
      expect(getQuestionSetFor(null, "NDA")?.key).toBe("nda");
      expect(getQuestionSetFor(null, "mutual_nda")?.key).toBe("nda");
    });

    it("matches Vendor via request_type and contract_type", () => {
      expect(getQuestionSetFor("vendor_agreement", null)?.key).toBe("vendor");
      expect(getQuestionSetFor(null, "Vendor agreement")?.key).toBe("vendor");
    });

    it("matches Employment, DPA, and MSA", () => {
      expect(getQuestionSetFor("employment_agreement", null)?.key).toBe(
        "employment",
      );
      expect(getQuestionSetFor(null, "DPA")?.key).toBe("dpa");
      expect(getQuestionSetFor(null, "MSA")?.key).toBe("msa");
    });

    it("falls back to 'other' when types are set but unrecognized", () => {
      expect(getQuestionSetFor("new_contract", null)?.key).toBe("other");
      expect(getQuestionSetFor(null, "Side letter")?.key).toBe("other");
    });
  });

  describe("summarizeAnswers", () => {
    it("returns empty string when no answers are filled", () => {
      const set = getQuestionSetFor("nda_review", null);
      expect(summarizeAnswers(set, {})).toBe("");
      expect(summarizeAnswers(set, { nda_direction: "" })).toBe("");
      expect(summarizeAnswers(set, { nda_direction: "   " })).toBe("");
    });

    it("renders a labelled summary for the matched set", () => {
      const set = getQuestionSetFor("nda_review", null);
      const text = summarizeAnswers(set, {
        nda_direction: "Mutual",
        nda_term: "3 years",
      });
      expect(text).toContain("Supporting questions (NDA review):");
      expect(text).toContain("Mutual");
      expect(text).toContain("3 years");
    });

    it("skips answers that don't belong to the matched set", () => {
      const set = getQuestionSetFor("nda_review", null);
      const text = summarizeAnswers(set, {
        nda_direction: "Mutual",
        unrelated_id: "should not appear",
      });
      expect(text).toContain("Mutual");
      expect(text).not.toContain("should not appear");
    });
  });

  describe("composeDescription", () => {
    it("joins summary and free text with a blank line", () => {
      expect(composeDescription("A", "B")).toBe("A\n\nB");
    });

    it("returns just the summary when free text is empty", () => {
      expect(composeDescription("A", "")).toBe("A");
      expect(composeDescription("A", "   ")).toBe("A");
    });

    it("returns just the free text when the summary is empty", () => {
      expect(composeDescription("", "B")).toBe("B");
    });

    it("returns empty when both are empty", () => {
      expect(composeDescription("", "")).toBe("");
    });
  });
});
