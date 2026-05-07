import { useCallback, useEffect, useMemo, useState } from "react";
import { createClauseTemplate, deactivateClauseTemplate, getClauseTemplates } from "../lib/api";
import type { ClauseTemplate } from "../types/clauseTemplates";

export default function ClauseLibraryPage() {
  const [items, setItems] = useState<ClauseTemplate[]>([]);
  const [clauseType, setClauseType] = useState("");
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");

  const load = useCallback(async () => {
    setItems(await getClauseTemplates({ clause_type: clauseType || undefined }));
  }, [clauseType]);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => items.filter((x) => !search || x.name.toLowerCase().includes(search.toLowerCase()) || x.text.toLowerCase().includes(search.toLowerCase())), [items, search]);

  return <div className="space-y-4 p-4">
    <h1 className="text-xl font-semibold">Clause Library</h1>
    <div className="flex gap-2"><input className="border p-2" placeholder="Filter clause type" value={clauseType} onChange={(e)=>setClauseType(e.target.value)} /><input className="border p-2" placeholder="Search" value={search} onChange={(e)=>setSearch(e.target.value)} /></div>
    <div className="flex gap-2"><input className="border p-2" placeholder="Name" value={name} onChange={(e)=>setName(e.target.value)} /><input className="border p-2 flex-1" placeholder="Clause text" value={text} onChange={(e)=>setText(e.target.value)} /><button className="border px-3" onClick={async()=>{ await createClauseTemplate({name, clause_type: clauseType || 'general', text}); setName(''); setText(''); await load(); }}>Create</button></div>
    <div className="space-y-2">{filtered.map((x)=><div key={x.id} className="border p-3"><div className="flex justify-between"><div><div className="font-medium">{x.name}</div><div className="text-xs text-gray-600">{x.clause_type}</div></div><button className="text-sm" onClick={async()=>{await deactivateClauseTemplate(x.id); await load();}}>Deactivate</button></div><pre className="whitespace-pre-wrap text-sm mt-2">{x.text}</pre></div>)}</div>
  </div>;
}
