import { describe, expect, it } from "vitest";

import {
  composeDescription,
  getQuestionSetFor,
  getQuestionSetForTemplate,
  parseSupportingQuestionsBlock,
  resolveQuestionSet,
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

  // -------------------------------------------------------------------------
  // Template-Aware Supporting Questions
  // -------------------------------------------------------------------------

  describe("getQuestionSetForTemplate", () => {
    it("returns null for nullish or empty templates", () => {
      expect(getQuestionSetForTemplate(null)).toBeNull();
      expect(getQuestionSetForTemplate(undefined)).toBeNull();
      expect(getQuestionSetForTemplate({})).toBeNull();
      expect(
        getQuestionSetForTemplate({ name: "", template_type: "" }),
      ).toBeNull();
    });

    it("matches NDA from template_type='NDA' or 'mutual_nda' slug", () => {
      expect(
        getQuestionSetForTemplate({ template_type: "NDA" })?.key,
      ).toBe("nda");
      expect(
        getQuestionSetForTemplate({ template_type: "mutual_nda" })?.key,
      ).toBe("nda");
    });

    it("matches NDA from metadata_json.contract_type taking precedence over template_type", () => {
      // The explicit contract_type slug on metadata_json should win
      // even when template_type is set to something else.
      const set = getQuestionSetForTemplate({
        template_type: "Other",
        metadata_json: { contract_type: "mutual_nda" },
      });
      expect(set?.key).toBe("nda");
    });

    it("matches DPA from contract_type='dpa' or template_type='DPA'", () => {
      expect(
        getQuestionSetForTemplate({
          metadata_json: { contract_type: "dpa" },
        })?.key,
      ).toBe("dpa");
      expect(
        getQuestionSetForTemplate({ template_type: "DPA" })?.key,
      ).toBe("dpa");
    });

    it("matches MSA from contract_type='msa' or template_type='MSA'", () => {
      expect(
        getQuestionSetForTemplate({
          metadata_json: { contract_type: "msa" },
        })?.key,
      ).toBe("msa");
      expect(
        getQuestionSetForTemplate({ template_type: "MSA" })?.key,
      ).toBe("msa");
    });

    it("matches Vendor from contract_type='vendor_agreement'", () => {
      expect(
        getQuestionSetForTemplate({
          metadata_json: { contract_type: "vendor_agreement" },
        })?.key,
      ).toBe("vendor");
    });

    it("matches Employment from contract_type='employment_agreement'", () => {
      expect(
        getQuestionSetForTemplate({
          metadata_json: { contract_type: "employment_agreement" },
        })?.key,
      ).toBe("employment");
    });

    it("uses conservative name inference only when no explicit type field is present", () => {
      // Explicit type wins over name.
      const ndaByType = getQuestionSetForTemplate({
        template_type: "DPA",
        name: "Mutual NDA",
      });
      expect(ndaByType?.key).toBe("dpa");

      // Name-only inference accepted for well-known phrases.
      expect(
        getQuestionSetForTemplate({ name: "Mutual NDA" })?.key,
      ).toBe("nda");
      expect(
        getQuestionSetForTemplate({ name: "Non-Disclosure Agreement" })?.key,
      ).toBe("nda");
      expect(
        getQuestionSetForTemplate({ name: "Data Processing Addendum" })?.key,
      ).toBe("dpa");
      expect(
        getQuestionSetForTemplate({ name: "Master Services Agreement" })?.key,
      ).toBe("msa");
      expect(
        getQuestionSetForTemplate({ name: "Standard Vendor Agreement" })?.key,
      ).toBe("vendor");
      expect(
        getQuestionSetForTemplate({ name: "Employment Agreement" })?.key,
      ).toBe("employment");
    });

    it("returns null for ambiguous template names with no type signal", () => {
      // Conservative — random names should not be force-classified.
      expect(
        getQuestionSetForTemplate({ name: "General Template" }),
      ).toBeNull();
      expect(
        getQuestionSetForTemplate({ name: "Side Letter Template" }),
      ).toBeNull();
      expect(
        getQuestionSetForTemplate({ name: "Standard Form" }),
      ).toBeNull();
    });

    it("ignores non-string contract_type values on metadata_json", () => {
      expect(
        getQuestionSetForTemplate({
          metadata_json: { contract_type: 42 as unknown as string },
        }),
      ).toBeNull();
    });
  });

  describe("resolveQuestionSet", () => {
    it("returns source='none' when no signals are present", () => {
      const result = resolveQuestionSet({});
      expect(result.set).toBeNull();
      expect(result.source).toBe("none");
    });

    it("prefers the template signal over request_type/contract_type", () => {
      const result = resolveQuestionSet({
        template: { template_type: "NDA" },
        requestType: "vendor_agreement",
        contractType: "Vendor agreement",
      });
      expect(result.set?.key).toBe("nda");
      expect(result.source).toBe("template");
    });

    it("falls back to request_type when no template signal is available", () => {
      const result = resolveQuestionSet({
        template: null,
        requestType: "nda_review",
      });
      expect(result.set?.key).toBe("nda");
      expect(result.source).toBe("request");
    });

    it("falls back to request_type when the template provides no confident signal", () => {
      // Template has no recognisable type fields and an ambiguous name.
      const result = resolveQuestionSet({
        template: { name: "General Template" },
        requestType: "vendor_agreement",
      });
      expect(result.set?.key).toBe("vendor");
      expect(result.source).toBe("request");
    });

    it("falls back to OTHER_SET (source='request') when request_type/contract_type are set but unrecognized", () => {
      const result = resolveQuestionSet({
        requestType: "new_contract",
        contractType: "Side letter",
      });
      expect(result.set?.key).toBe("other");
      expect(result.source).toBe("request");
    });
  });

  describe("summary remains compatible with parser when set comes from template", () => {
    it("renders the labelled summary using the template-derived set heading", () => {
      // Pretend a vendor template was selected but the request type is
      // still the generic 'new_contract'. The summary should reflect
      // the template-derived set, not the request type.
      const resolved = resolveQuestionSet({
        template: { template_type: "vendor_agreement" },
        requestType: "new_contract",
      });
      const text = summarizeAnswers(resolved.set, {
        vendor_product: "Cloud hosting",
      });
      expect(text).toContain("Supporting questions (Vendor agreement):");
      // Round-trips through the existing parser used by Request Detail.
      const parsed = parseSupportingQuestionsBlock(text);
      expect(parsed).not.toBeNull();
      expect(parsed!.label).toBe("Vendor agreement");
      expect(parsed!.rows[0].answer).toBe("Cloud hosting");
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
