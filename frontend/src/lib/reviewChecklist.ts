export interface ChecklistItem {
  label: string;
}

export interface ChecklistResult {
  items: ChecklistItem[];
  matched: boolean;
}

const CHECKLISTS: Record<string, ChecklistItem[]> = {
  nda: [
    { label: "Confidentiality scope" },
    { label: "Term / survival" },
    { label: "Residuals" },
    { label: "Governing law" },
    { label: "Return/destruction of materials" },
  ],
  dpa: [
    { label: "Data categories" },
    { label: "Subprocessors" },
    { label: "Security measures" },
    { label: "Cross-border transfers" },
    { label: "Incident notice" },
  ],
  msa: [
    { label: "SOW linkage" },
    { label: "Payment terms" },
    { label: "Limitation of liability" },
    { label: "Indemnity" },
    { label: "Termination" },
  ],
  "vendor agreement": [
    { label: "Service levels" },
    { label: "Payment" },
    { label: "Data access" },
    { label: "Termination" },
    { label: "Liability cap" },
  ],
  employment: [
    { label: "Role/compensation" },
    { label: "Confidentiality" },
    { label: "IP assignment" },
    { label: "Restrictive covenants" },
    { label: "Termination" },
  ],
};

const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { label: "Parties" },
  { label: "Term" },
  { label: "Payment/consideration" },
  { label: "Liability" },
  { label: "Governing law" },
];

export function getReviewChecklist(
  contractType: string | null | undefined,
): ChecklistResult {
  if (contractType) {
    const key = contractType.trim().toLowerCase();
    if (key in CHECKLISTS) {
      return { items: CHECKLISTS[key], matched: true };
    }
  }
  return { items: DEFAULT_CHECKLIST, matched: false };
}
