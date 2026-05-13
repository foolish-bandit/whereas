interface PageHeaderProps {
  title: string;
  description?: string;
  /** Breadcrumb or category label rendered above the title. */
  eyebrow?: React.ReactNode;
  /** Buttons, toggles, or other controls placed to the right of the title block. */
  actions?: React.ReactNode;
}

export default function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
      <div>
        {eyebrow && <div className="mb-1">{eyebrow}</div>}
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}
