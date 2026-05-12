import { describe, expect, it } from "vitest";

import {
  composeDescription,
  getQuestionSetFor,
  parseSupportingQuestionsBlock,
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

  describe("parseSupportingQuestionsBlock", () => {
    it("returns null for null, undefined, or empty string", () => {
      expect(parseSupportingQuestionsBlock(null)).toBeNull();
      expect(parseSupportingQuestionsBlock(undefined)).toBeNull();
      expect(parseSupportingQuestionsBlock("")).toBeNull();
    });

    it("returns null when no supporting-questions header is present", () => {
      expect(parseSupportingQuestionsBlock("Just a plain description.")).toBeNull();
      expect(
        parseSupportingQuestionsBlock(
          "Please review the data security addendum.",
        ),
      ).toBeNull();
    });

    it("returns null when the header matches but there are no bullet lines", () => {
      expect(
        parseSupportingQuestionsBlock("Supporting questions (NDA review):"),
      ).toBeNull();
    });

    it("parses label and bullet rows correctly", () => {
      const desc =
        "Supporting questions (NDA review):\n• Is this mutual or one-way? Mutual\n• Who is disclosing confidential information? Both parties";
      const result = parseSupportingQuestionsBlock(desc);
      expect(result).not.toBeNull();
      expect(result!.label).toBe("NDA review");
      expect(result!.rows).toHaveLength(2);
      expect(result!.rows[0]).toEqual({
        question: "Is this mutual or one-way?",
        answer: "Mutual",
      });
      expect(result!.rows[1]).toEqual({
        question: "Who is disclosing confidential information?",
        answer: "Both parties",
      });
      expect(result!.remainingDescription).toBe("");
    });

    it("extracts remaining free-text after a blank-line separator", () => {
      const desc =
        "Supporting questions (Vendor agreement):\n• What product or service is being purchased? Cloud hosting\n• Is this a new vendor or renewal? New vendor\n\nPlease also review the data security addendum and liability cap.";
      const result = parseSupportingQuestionsBlock(desc);
      expect(result).not.toBeNull();
      expect(result!.label).toBe("Vendor agreement");
      expect(result!.rows).toHaveLength(2);
      expect(result!.remainingDescription).toBe(
        "Please also review the data security addendum and liability cap.",
      );
    });

    it("splits on '.' when no '?' is present in a bullet", () => {
      const desc =
        "Supporting questions (General context):\n• Briefly describe the deal or request. Cloud hosting renewal for two years.";
      const result = parseSupportingQuestionsBlock(desc);
      expect(result).not.toBeNull();
      expect(result!.rows[0].question).toBe(
        "Briefly describe the deal or request.",
      );
      expect(result!.rows[0].answer).toBe(
        "Cloud hosting renewal for two years.",
      );
    });

    it("stores the full bullet as question with empty answer when no split marker is found", () => {
      const desc =
        "Supporting questions (NDA review):\n• Is this mutual or one-way Mutual";
      const result = parseSupportingQuestionsBlock(desc);
      expect(result).not.toBeNull();
      expect(result!.rows[0].question).toBe("Is this mutual or one-way Mutual");
      expect(result!.rows[0].answer).toBe("");
    });

    it("returns null (fail safe) when a non-bullet non-empty line appears inside the block", () => {
      const desc =
        "Supporting questions (NDA review):\nIs this mutual or one-way? Mutual\n• Who is disclosing? Both";
      expect(parseSupportingQuestionsBlock(desc)).toBeNull();
    });

    it("is consistent with summarizeAnswers output: round-trips through composeDescription", () => {
      const set = getQuestionSetFor("nda_review", null)!;
      const answers = {
        nda_direction: "Mutual",
        nda_discloser: "Both parties",
      };
      const summary = summarizeAnswers(set, answers);
      const freeText = "Please review liability.";
      const composed = composeDescription(summary, freeText);
      const result = parseSupportingQuestionsBlock(composed);
      expect(result).not.toBeNull();
      expect(result!.label).toBe("NDA review");
      expect(result!.rows).toHaveLength(2);
      expect(result!.remainingDescription).toBe(freeText);
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
