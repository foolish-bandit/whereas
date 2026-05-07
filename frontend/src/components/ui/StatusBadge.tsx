export function StatusBadge({ status }: { status: string }) {
  const color = status === 'ready' ? 'bg-emerald-100 text-emerald-700' : status === 'failed' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-700'
  return <span className={`rounded px-2 py-1 text-xs font-medium ${color}`}>{status}</span>
}
