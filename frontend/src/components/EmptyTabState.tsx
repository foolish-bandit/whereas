interface EmptyTabStateProps {
  label: string;
  message: string;
}

export default function EmptyTabState({ label, message }: EmptyTabStateProps) {
  return (
    <div
      className="rounded-lg border border-rule bg-canvas px-5 py-6 text-center"
      data-testid={`empty-tab-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
        {label}
      </p>
      <p className="mt-2 text-sm text-ink-muted">{message}</p>
    </div>
  );
}
