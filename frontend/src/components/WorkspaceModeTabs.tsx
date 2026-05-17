interface ModeTabSpec<T extends string> {
  id: T;
  label: string;
}

interface WorkspaceModeTabsProps<T extends string> {
  tabs: readonly ModeTabSpec<T>[];
  active: T;
  onChange: (id: T) => void;
}

/**
 * Primary mode tabs at the top of the contract workspace rail
 * (``Read | Negotiate | History``). Sits above the existing
 * ``RightPanelTabs`` row, which renders the sub-tabs for the active
 * mode. Visually heavier than the sub-tabs so the user can tell
 * which mode they're in at a glance.
 *
 * The component is rendered with ``role="tablist"`` and the
 * individual tabs as ``role="tab"`` so the screen-reader experience
 * is consistent with the sub-tab row, but the two rows are
 * semantically distinct: the sub-tabs target the rail's
 * ``role="tabpanel"`` blocks; the mode tabs only switch which
 * sub-tabs are visible.
 */
export default function WorkspaceModeTabs<T extends string>({
  tabs,
  active,
  onChange,
}: WorkspaceModeTabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label="Contract workspace mode"
      className="mb-2 flex w-full overflow-x-auto rounded-md border border-rule bg-canvas-subtle p-0.5 scrollbar-thin"
      data-testid="workspace-mode-tabs"
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
            data-testid={`workspace-mode-tab-${tab.id}`}
            className={[
              "flex-1 shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-xs font-semibold transition-colors",
              isActive
                ? "bg-canvas text-ink shadow-sm"
                : "text-ink-muted hover:text-ink",
            ].join(" ")}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
