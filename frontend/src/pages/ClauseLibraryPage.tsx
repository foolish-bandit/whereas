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

  return <div className="space-y-4">
    <h1 className="text-lg font-semibold">Clause Library</h1>
    <div className="grid gap-2 rounded border border-rule p-3">
      <input className="rounded border border-rule px-2 py-1" placeholder="Name" value={name} onChange={(e)=>setName(e.target.value)} />
      <input className="rounded border border-rule px-2 py-1" placeholder="Clause type" value={clauseType} onChange={(e)=>setClauseType(e.target.value)} />
      <textarea className="rounded border border-rule px-2 py-1" placeholder="Approved clause text" value={text} onChange={(e)=>setText(e.target.value)} />
      <button className="rounded border border-ink bg-ink px-3 py-1 text-canvas w-fit" onClick={onCreate}>Create template</button>
    </div>
    <div className="flex gap-2">
      <input className="rounded border border-rule px-2 py-1" placeholder="Search" value={query} onChange={(e)=>setQuery(e.target.value)} />
      <input className="rounded border border-rule px-2 py-1" placeholder="Filter clause type" value={clauseType} onChange={(e)=>setClauseType(e.target.value)} />
    </div>
    <ul className="space-y-2">
      {filtered.map((r) => <li key={r.id} className="rounded border border-rule p-3">
        <div className="flex items-center justify-between"><div><p className="font-medium">{r.name}</p><p className="text-xs text-ink-subtle">{r.clause_type}</p></div>
        <button className="text-xs underline" onClick={()=>onDeactivate(r.id)}>Deactivate</button></div>
        <pre className="mt-2 whitespace-pre-wrap text-sm text-ink-muted">{r.text}</pre>
      </li>)}
    </ul>
  </div>;
}
