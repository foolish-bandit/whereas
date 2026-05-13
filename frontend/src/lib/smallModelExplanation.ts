export type ExplanationInstructionStyle =
  | "business_explanation"
  | "reviewer_comment"
  | "negotiation_comment";

export interface ExplanationFindingInput {
  title?: string;
  issue?: string;
  labels?: string[];
}

export interface ExplanationRequest {
  finding: ExplanationFindingInput;
  citedSourceExcerpt?: string;
  citedSourceLabel?: string;
  sourceSpanReference?: string;
  playbookBasis?: string;
  approvedFallbackLanguage?: string;
  instructionStyle: ExplanationInstructionStyle;
}

export interface ExplanationWriterConfig {
  providerEnabled: boolean;
  defaultModelName?: string;
}

export interface ExplanationResponse {
  status: "disabled" | "warning";
  explanationText: null;
  modelName?: string;
  grounded: boolean;
  warnings: string[];
}

const STYLE_INSTRUCTIONS: Record<ExplanationInstructionStyle, string> = {
  business_explanation:
    "Write a concise business-facing explanation focused on operational risk and contract impact.",
  reviewer_comment:
    "Write a concise reviewer comment suitable for internal legal/ops review notes.",
  negotiation_comment:
    "Write a concise negotiation comment suitable for counterparty discussion without legal conclusions.",
};

export function isSufficientlyGrounded(request: ExplanationRequest): {
  grounded: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const hasFindingContext = Boolean(request.finding.title || request.finding.issue);
  const hasSource = Boolean(request.citedSourceExcerpt || request.sourceSpanReference);
  const hasBasis = Boolean(request.playbookBasis || request.approvedFallbackLanguage);

  if (!hasFindingContext) {
    warnings.push("Missing finding title or issue context.");
  }
  if (!hasSource) {
    warnings.push("Missing source grounding (excerpt or source span reference).");
  }
  if (!hasBasis) {
    warnings.push("Missing playbook basis or approved fallback language.");
  }

  return { grounded: hasFindingContext && hasSource && hasBasis, warnings };
}

export function buildExplanationPrompt(request: ExplanationRequest): {
  prompt: string | null;
  grounded: boolean;
  warnings: string[];
} {
  const grounding = isSufficientlyGrounded(request);
  if (!grounding.grounded) {
    return { prompt: null, grounded: false, warnings: grounding.warnings };
  }

  const findingLabel = request.citedSourceLabel ?? "finding";
  const findingTitle = request.finding.title ?? request.finding.issue ?? "(not provided)";
  const findingIssue = request.finding.issue ?? "(not provided)";

  const sections = [
    "System constraints:",
    "- Do not provide legal advice.",
    "- Do not invent facts.",
    "- Use only supplied source/playbook/fallback material.",
    "- Keep output short.",
    "- Cite supplied finding/source labels in the output.",
    "- If grounding is insufficient, explicitly say grounding is insufficient.",
    "- Do not produce new findings.",
    "- Do not contradict the playbook basis.",
    "- Do not imply human approval.",
    "",
    `Instruction style: ${request.instructionStyle}`,
    `Style guidance: ${STYLE_INSTRUCTIONS[request.instructionStyle]}`,
    "",
    "Grounded materials:",
    `- Finding label: ${findingLabel}`,
    `- Finding title: ${findingTitle}`,
    `- Finding issue: ${findingIssue}`,
    `- Source label: ${request.citedSourceLabel ?? "(not provided)"}`,
    `- Source excerpt: ${request.citedSourceExcerpt ?? "(not provided)"}`,
    `- Source span reference: ${request.sourceSpanReference ?? "(not provided)"}`,
    `- Playbook basis: ${request.playbookBasis ?? "(not provided)"}`,
    `- Approved fallback language: ${request.approvedFallbackLanguage ?? "(not provided)"}`,
  ];

  return { prompt: sections.join("\n"), grounded: true, warnings: [] };
}

export function writeSmallModelExplanation(
  request: ExplanationRequest,
  config: ExplanationWriterConfig,
): ExplanationResponse {
  const grounding = isSufficientlyGrounded(request);

  if (!config.providerEnabled) {
    return {
      status: "disabled",
      explanationText: null,
      grounded: grounding.grounded,
      warnings: grounding.warnings,
    };
  }

  return {
    status: "warning",
    explanationText: null,
    modelName: config.defaultModelName,
    grounded: grounding.grounded,
    warnings: grounding.grounded
      ? ["Explanation writer provider interface is planned but not active."]
      : grounding.warnings,
  };
}
