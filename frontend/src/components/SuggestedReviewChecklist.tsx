import { useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { getReviewChecklist } from "../lib/reviewChecklist";
import { mountedPath } from "../lib/routes";

interface Props {
  contractType: string | null | undefined;
  onOpenReviewTab?: () => void;
}

export default function SuggestedReviewChecklist({
  contractType,
  onOpenReviewTab,
}: Props) {
  const location = useLocation();
  const { items, matched } = getReviewChecklist(contractType);
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  function toggle(idx: number) {
    setChecked((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }

  return (
    <section
      className="rounded border border-rule p-4"
      data-testid="suggested-review-checklist"
    >
      <div>
        <h2 className="text-sm font-medium text-ink">
          Suggested review checklist
        </h2>
        <p className="mt-0.5 text-xs text-ink-subtle">
          {matched
            ? `Suggested based on contract type (${contractType}). This is a workflow aid, not legal advice.`
            : "Suggested based on contract type. This is a workflow aid, not legal advice."}
        </p>
      </div>
      <ul
        className="mt-3 space-y-2"
        data-testid="review-checklist-items"
      >
        {items.map((item, idx) => (
          <li key={idx} className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`checklist-item-${idx}`}
              checked={!!checked[idx]}
              onChange={() => toggle(idx)}
              className="h-4 w-4 cursor-pointer rounded border-rule"
              data-testid="checklist-item-checkbox"
            />
            <label
              htmlFor={`checklist-item-${idx}`}
              className="cursor-pointer text-sm text-ink"
              data-testid="checklist-item-label"
            >
              {item.label}
            </label>
          </li>
        ))}
      </ul>
      <div
        className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1"
        data-testid="review-checklist-actions"
      >
        <Link
          to={mountedPath("/playbooks", location.pathname)}
          className="text-xs text-ink-muted underline-offset-2 hover:underline"
          data-testid="checklist-link-playbooks"
        >
          Open Playbooks
        </Link>
        <Link
          to={mountedPath("/clause-manager", location.pathname)}
          className="text-xs text-ink-muted underline-offset-2 hover:underline"
          data-testid="checklist-link-clause-manager"
        >
          Open Clause Manager
        </Link>
        {onOpenReviewTab && (
          <button
            type="button"
            className="text-xs text-ink-muted underline-offset-2 hover:underline"
            onClick={onOpenReviewTab}
            data-testid="checklist-open-review-tab"
          >
            Open Review tab
          </button>
        )}
      </div>
    </section>
  );
}
