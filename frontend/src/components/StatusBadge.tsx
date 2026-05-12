import type { ContractStatus } from "../types/contracts";
import { statusToPill } from "../lib/contract-status";
import Pill from "./ui/Pill";

interface StatusBadgeProps {
  status: ContractStatus | string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const { label, tone } = statusToPill(status);
  return (
    <Pill tone={tone} variant="soft" className="gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </Pill>
  );
}
