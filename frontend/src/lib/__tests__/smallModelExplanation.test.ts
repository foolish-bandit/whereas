import { describe, expect, it, vi } from "vitest";

import {
  buildExplanationPrompt,
  isSufficientlyGrounded,
  writeSmallModelExplanation,
  type ExplanationRequest,
} from "../smallModelExplanation";

const groundedRequest: ExplanationRequest = {
  finding: {
    title: "Liability cap exceeds policy",
    issue: "Cap is 3x fees",
    labels: ["F1", "S1"],
  },
  citedSourceExcerpt: "... liability shall not exceed three (3) times the fees ...",
  citedSourceLabel: "S1",
  sourceSpanReference: "contract.md#L220-L230",
  playbookBasis: "Liability cap must be 1x fees unless approved.",
  approvedFallbackLanguage: "Cap at fees paid in prior 12 months.",
  instructionStyle: "business_explanation",
};

describe("smallModelExplanation", () => {
  it("disabled provider returns disabled response", () => {
    const response = writeSmallModelExplanation(groundedRequest, {
      providerEnabled: false,
      defaultModelName: "Qwen2.5-1.5B-Instruct",
    });

    expect(response.status).toBe("disabled");
    expect(response.explanationText).toBeNull();
    expect(response.grounded).toBe(true);
    expect(response.modelName).toBeUndefined();
  });

  it("prompt template includes grounding constraints", () => {
    const { prompt, grounded } = buildExplanationPrompt(groundedRequest);

    expect(grounded).toBe(true);
    expect(prompt).toContain("Do not provide legal advice");
    expect(prompt).toContain("Do not invent facts");
    expect(prompt).toContain("Use only supplied source/playbook/fallback material");
    expect(prompt).toContain("If grounding is insufficient");
    expect(prompt).toContain("Do not produce new findings");
    expect(prompt).toContain("Do not contradict the playbook basis");
    expect(prompt).toContain("Do not imply human approval");
  });

  it("missing source/playbook basis triggers warning", () => {
    const grounding = isSufficientlyGrounded({
      ...groundedRequest,
      citedSourceExcerpt: undefined,
      sourceSpanReference: undefined,
      playbookBasis: undefined,
      approvedFallbackLanguage: undefined,
    });

    expect(grounding.grounded).toBe(false);
    expect(grounding.warnings.join(" ")).toContain("Missing source grounding");
    expect(grounding.warnings.join(" ")).toContain("Missing playbook basis");

    const promptBuild = buildExplanationPrompt({
      ...groundedRequest,
      citedSourceExcerpt: undefined,
      sourceSpanReference: undefined,
    });
    expect(promptBuild.prompt).toBeNull();
  });

  it("business_explanation style produces correct instruction framing", () => {
    const { prompt } = buildExplanationPrompt({ ...groundedRequest, instructionStyle: "business_explanation" });
    expect(prompt).toContain("business-facing explanation");
  });

  it("reviewer_comment style produces correct instruction framing", () => {
    const { prompt } = buildExplanationPrompt({ ...groundedRequest, instructionStyle: "reviewer_comment" });
    expect(prompt).toContain("internal legal/ops review notes");
  });

  it("negotiation_comment style produces correct instruction framing", () => {
    const { prompt } = buildExplanationPrompt({ ...groundedRequest, instructionStyle: "negotiation_comment" });
    expect(prompt).toContain("counterparty discussion");
  });

  it("generated prompt does not include forbidden internal fields", () => {
    const { prompt } = buildExplanationPrompt(groundedRequest);
    const forbidden = [
      "storage_key",
      "wrapped_dek",
      "wrapped_master_key",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned_url",
      "docuseal_webhook_secret",
      "docuseal_api_token",
    ];

    for (const token of forbidden) {
      expect(prompt).not.toContain(token);
    }
  });

  it("no network/subprocess/model execution occurs", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    writeSmallModelExplanation(groundedRequest, {
      providerEnabled: false,
      defaultModelName: "SmolLM2-1.7B-Instruct",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
