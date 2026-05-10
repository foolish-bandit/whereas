import { useEffect, useMemo, useState } from "react";
import { createClauseTemplate, deleteClauseTemplate, listClauseTemplates } from "../lib/api";
import type { ClauseTemplate } from "../types/clauseTemplates";

export default function ClauseLibraryPage() {
  const [rows, setRows] = useState<ClauseTemplate[]>([]);
  const [query, setQuery] = useState("");
  const [clauseType, setClauseType] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");

  useEffect(() => {
    listClauseTemplates().then(setRows);
  }, []);

  const filtered = useMemo(() => rows.filter((r) =>
    (!clauseType || r.clause_type === clauseType) &&
    (!query || `${r.name} ${r.text}`.toLowerCase().includes(query.toLowerCase()))
  ), [rows, clauseType, query]);

  async function onCreate() {
    if (!name.trim() || !text.trim()) return;
    const created = await createClauseTemplate({ name, text, clause_type: clauseType || "general" });
    setRows((prev) => [created, ...prev]);
    setName(""); setText("");
  }

  async function onDeactivate(id: string) {
    await deleteClauseTemplate(id);
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  return (
    <div className="space-y-4" data-testid="clause-manager-page">
      <div>
        <h1 className="text-lg font-semibold">Clause Manager</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Approved clauses, fallback language, and reusable drafting
          guidance. Browse and curate the language your team can drop into
          new agreements.
        </p>
      </div>
      <div className="grid gap-2 rounded border border-rule p-3">
        <input
          className="w-full rounded border border-rule px-2 py-1.5 text-sm"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="w-full rounded border border-rule px-2 py-1.5 text-sm"
          placeholder="Clause type"
          value={clauseType}
          onChange={(e) => setClauseType(e.target.value)}
        />
        <textarea
          className="w-full min-h-[5rem] rounded border border-rule px-2 py-1.5 text-sm"
          placeholder="Approved clause text"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas sm:w-fit sm:py-1"
          onClick={onCreate}
        >
          Create template
        </button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <input
          className="w-full min-w-0 flex-1 rounded border border-rule px-2 py-1.5 text-sm sm:w-auto"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          className="w-full min-w-0 flex-1 rounded border border-rule px-2 py-1.5 text-sm sm:w-auto"
          placeholder="Filter clause type"
          value={clauseType}
          onChange={(e) => setClauseType(e.target.value)}
        />
      </div>
      <ul className="space-y-2">
        {filtered.map((r) => (
          <li key={r.id} className="rounded border border-rule p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words font-medium">{r.name}</p>
                <p className="text-xs text-ink-subtle">{r.clause_type}</p>
              </div>
              <button
                className="shrink-0 text-xs underline"
                onClick={() => onDeactivate(r.id)}
              >
                Deactivate
              </button>
            </div>
            <pre className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-muted">
              {r.text}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
