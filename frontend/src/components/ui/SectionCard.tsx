interface SectionCardProps {
  title: string;
  description?: string;
  /** Control or button placed to the right of the title. */
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
  id?: string;
}

export default function SectionCard({
  title,
  description,
  action,
  children,
  testId,
  id,
}: SectionCardProps) {
  return (
    <section
      className="rounded border border-rule p-3"
      data-testid={testId}
      id={id}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
