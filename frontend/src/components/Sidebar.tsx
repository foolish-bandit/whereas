import { NavLink } from "react-router-dom";

const NAV = [
  { to: "/contracts", label: "Contracts" },
  { to: "/playbooks", label: "Playbooks" },
  { to: "/upload", label: "Upload" },
  { to: "/clause-library", label: "Clause Library" },
  { to: "/settings", label: "Settings" },
];

export default function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-rule bg-canvas md:flex">
      <div className="flex h-14 items-center border-b border-rule px-5">
        <span className="font-serif text-lg tracking-tight text-ink">
          Whereas
        </span>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 p-3 text-sm">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                "rounded px-3 py-2 transition-colors",
                isActive
                  ? "bg-canvas-muted font-medium text-ink"
                  : "text-ink-muted hover:bg-canvas-muted hover:text-ink",
              ].join(" ")
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-rule px-5 py-4 text-xs text-ink-subtle">
        <p>Self-hosted workspace</p>
        <p className="mt-1">v0.0.1 · pre-release</p>
      </div>
    </aside>
  );
}
