import type { PillTone } from "../components/ui/Pill";
import type { ContractStatus } from "../types/contracts";

export interface StatusPillSpec {
  label: string;
  tone: PillTone;
}

const SPECS: Record<string, StatusPillSpec> = {
  uploaded: { label: "Uploaded", tone: "info" },
  extracting: { label: "Extracting", tone: "info" },
  ready: { label: "Ready", tone: "success" },
  failed: { label: "Extraction failed", tone: "danger" },
  sent_for_signature: { label: "Sent for signature", tone: "neutral" },
  executed: { label: "Executed", tone: "success" },
};

export function statusToPill(status: ContractStatus | string): StatusPillSpec {
  return SPECS[status] ?? { label: status || "Unknown", tone: "neutral" };
}
