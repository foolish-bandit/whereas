interface TabSpec<T extends string> {
  id: T;
  label: string;
  count?: number;
}

interface RightPanelTabsProps<T extends string> {
  tabs: readonly TabSpec<T>[];
  active: T;
  onChange: (id: T) => void;
}

export default function RightPanelTabs<T extends string>({
  tabs,
  active,
  onChange,
}: RightPanelTabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label="Contract workspace panels"
      className="mb-3 inline-flex rounded-md border border-rule bg-canvas p-0.5"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={[
              "rounded px-3 py-1 text-xs font-medium transition-colors",
              isActive
                ? "bg-ink text-canvas"
                : "text-ink-muted hover:text-ink",
            ].join(" ")}
          >
            {tab.label}
            {typeof tab.count === "number" && (
              <span
                className={[
                  "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px]",
                  isActive
                    ? "bg-canvas text-ink"
                    : "bg-canvas-subtle text-ink-muted",
                ].join(" ")}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
