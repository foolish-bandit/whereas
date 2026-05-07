import type { ReactNode } from "react";

interface ErrorStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export default function ErrorState({
  title,
  description,
  action,
}: ErrorStateProps) {
  return (
    <div className="rounded-lg border border-danger-ring bg-danger-soft px-5 py-4 text-sm">
      <p className="font-medium text-danger">{title}</p>
      {description && (
        <p className="mt-1 text-ink-muted">{description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
