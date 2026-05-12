import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  getContracts,
  getPlaybooks,
  listClauseTemplates,
  listRequests,
} from "../lib/api";
import { demoPath } from "../lib/routes";
import type { ContractListItem } from "../types/contracts";
import type { ClauseTemplate } from "../types/clauseTemplates";
import type { PlaybookSummary } from "../types/playbooks";
import type { ContractRequest } from "../types/requests";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface PaletteIndex {
  contracts: ContractListItem[];
  requests: ContractRequest[];
  clauses: ClauseTemplate[];
  playbooks: PlaybookSummary[];
}

const NAV_DESTINATIONS = [
  { label: "Dashboard", to: demoPath("/dashboard"), hint: "g d" },
  { label: "Inbox", to: demoPath("/inbox"), hint: "g i" },
  { label: "Approvals", to: demoPath("/approvals"), hint: "g a" },
  { label: "Repository", to: demoPath("/repository"), hint: "g r" },
  { label: "Requests", to: demoPath("/requests"), hint: "g q" },
  { label: "Templates", to: demoPath("/requests/templates"), hint: null },
  { label: "Playbooks", to: demoPath("/playbooks"), hint: "g p" },
  { label: "Clause Manager", to: demoPath("/clause-manager"), hint: "g c" },
  { label: "Settings", to: demoPath("/settings"), hint: null },
  { label: "Integrations", to: demoPath("/integrations"), hint: null },
];

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [index, setIndex] = useState<PaletteIndex>({
    contracts: [],
    requests: [],
    clauses: [],
    playbooks: [],
  });

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    Promise.allSettled([
      getContracts({ signal: controller.signal, include_merged: true, q: "" }),
      listRequests({}, { signal: controller.signal }),
      listClauseTemplates({}, { signal: controller.signal }),
      getPlaybooks({ signal: controller.signal }),
    ]).then((results) => {
      if (controller.signal.aborted) return;
      const [c, r, cl, p] = results;
      setIndex({
        contracts: c.status === "fulfilled" ? c.value : [],
        requests: r.status === "fulfilled" ? r.value : [],
        clauses: cl.status === "fulfilled" ? cl.value : [],
        playbooks: p.status === "fulfilled" ? p.value : [],
      });
    });
    return () => controller.abort();
  }, [open]);

  function go(to: string) {
    navigate(to);
    onClose();
  }

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[15vh] backdrop-blur"
      data-testid="command-palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Command
        label="Global command palette"
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-rule bg-canvas shadow-xl"
        data-testid="command-palette"
      >
        <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
          <span aria-hidden className="text-ink-subtle">
            🔍
          </span>
          <Command.Input
            autoFocus
            placeholder="Search contracts, requests, clauses, rules…"
            className="w-full bg-canvas py-1 text-sm text-ink placeholder:text-ink-subtle focus:outline-none"
            data-testid="command-palette-input"
          />
          <kbd className="rounded border border-rule px-1.5 py-0.5 text-[10px] text-ink-subtle">
            esc
          </kbd>
        </div>
        <Command.List className="max-h-[60vh] overflow-y-auto py-1">
          <Command.Empty className="px-3 py-6 text-center text-sm text-ink-muted">
            No matches.
          </Command.Empty>

          {index.contracts.length > 0 && (
            <Command.Group
              heading="Contracts"
              className="px-2 py-1"
              data-testid="command-group-contracts"
            >
              {index.contracts.slice(0, 25).map((c) => (
                <Command.Item
                  key={c.id}
                  value={`${c.title} ${c.counterparty ?? ""} ${c.mime_type}`}
                  onSelect={() => go(demoPath(`/repository/${c.id}`))}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm aria-selected:bg-canvas-subtle"
                >
                  <span className="min-w-0 truncate">
                    <span aria-hidden className="mr-2 text-ink-subtle">
                      📄
                    </span>
                    {c.title}
                  </span>
                  <span className="shrink-0 text-xs text-ink-subtle">
                    {c.counterparty ?? c.mime_type}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {index.requests.length > 0 && (
            <Command.Group
              heading="Requests"
              className="px-2 py-1"
              data-testid="command-group-requests"
            >
              {index.requests.slice(0, 25).map((r) => (
                <Command.Item
                  key={r.id}
                  value={`${r.title} ${r.counterparty_name ?? ""} ${r.request_type ?? ""}`}
                  onSelect={() => go(demoPath(`/requests/${r.id}`))}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm aria-selected:bg-canvas-subtle"
                >
                  <span className="min-w-0 truncate">
                    <span aria-hidden className="mr-2 text-ink-subtle">
                      🧾
                    </span>
                    {r.title}
                  </span>
                  <span className="shrink-0 text-xs text-ink-subtle">
                    {r.counterparty_name ?? r.request_type ?? r.status}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {index.clauses.length > 0 && (
            <Command.Group
              heading="Clauses"
              className="px-2 py-1"
              data-testid="command-group-clauses"
            >
              {index.clauses.slice(0, 25).map((c) => (
                <Command.Item
                  key={c.id}
                  value={`${c.name} ${c.clause_type ?? ""}`}
                  onSelect={() => go(demoPath(`/clause-manager?clause=${c.id}`))}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm aria-selected:bg-canvas-subtle"
                >
                  <span className="min-w-0 truncate">
                    <span aria-hidden className="mr-2 text-ink-subtle">
                      🪶
                    </span>
                    {c.name}
                  </span>
                  <span className="shrink-0 text-xs text-ink-subtle">
                    {c.clause_type ?? "—"}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {index.playbooks.length > 0 && (
            <Command.Group
              heading="Playbook rules"
              className="px-2 py-1"
              data-testid="command-group-playbooks"
            >
              {index.playbooks.slice(0, 25).map((p) => (
                <Command.Item
                  key={p.id}
                  value={`${p.name} ${p.contract_type ?? ""}`}
                  onSelect={() => go(demoPath(`/playbooks/${p.id}`))}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm aria-selected:bg-canvas-subtle"
                >
                  <span className="min-w-0 truncate">
                    <span aria-hidden className="mr-2 text-ink-subtle">
                      📘
                    </span>
                    {p.name}
                  </span>
                  <span className="shrink-0 text-xs text-ink-subtle">
                    {p.contract_type ?? `${p.rule_count} rules`}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group
            heading="Navigate"
            className="px-2 py-1"
            data-testid="command-group-navigate"
          >
            {NAV_DESTINATIONS.map((n) => (
              <Command.Item
                key={n.to}
                value={`navigate ${n.label}`}
                onSelect={() => go(n.to)}
                className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm aria-selected:bg-canvas-subtle"
              >
                <span>
                  <span aria-hidden className="mr-2 text-ink-subtle">
                    →
                  </span>
                  {n.label}
                </span>
                {n.hint && (
                  <kbd className="rounded border border-rule px-1.5 py-0.5 text-[10px] text-ink-subtle">
                    {n.hint}
                  </kbd>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
