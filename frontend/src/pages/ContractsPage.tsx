import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getContracts } from '../lib/api'
import type { ContractListItem } from '../types/contracts'
import { StatusBadge } from '../components/ui/StatusBadge'

export function ContractsPage({ devUserId }: { devUserId: string }) {
  const [items, setItems] = useState<ContractListItem[]>([])
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => { if (!devUserId) { setLoading(false); return } ; setLoading(true); getContracts(devUserId).then(setItems).catch(e=>setError(e.message)).finally(()=>setLoading(false)) }, [devUserId])
  const filtered = useMemo(()=>items.filter(i => `${i.title} ${i.status} ${i.mime_type}`.toLowerCase().includes(q.toLowerCase())), [items,q])
  if (!devUserId) return <div className='rounded border border-amber-200 bg-amber-50 p-3 text-sm'>Set a development user ID to call the local API.</div>
  return <div>
    <div className='mb-3 flex items-center justify-between'><h2 className='text-xl font-semibold'>Contracts</h2><Link className='rounded bg-slate-900 px-3 py-2 text-sm text-white' to='/upload'>Upload</Link></div>
    <input placeholder='Search title, status, type' value={q} onChange={(e)=>setQ(e.target.value)} className='mb-3 w-full rounded border p-2' />
    {loading ? <div className='rounded border bg-white p-4 text-sm text-slate-500'>Loading contracts…</div> : error ? <div className='rounded border border-rose-200 bg-rose-50 p-3 text-sm'>{error}</div> : filtered.length===0 ? <div className='rounded border bg-white p-4 text-sm'>No contracts yet.</div> :
    <table className='w-full overflow-hidden rounded border bg-white text-sm'><thead className='bg-slate-100 text-left'><tr><th className='p-2'>Title</th><th>Status</th><th>Type</th><th>Pages</th><th>Uploaded</th><th>Updated</th></tr></thead><tbody>{filtered.map(i=><tr key={i.id} className='border-t hover:bg-slate-50'><td className='p-2'><Link className='underline' to={`/contracts/${i.id}`}>{i.title}</Link></td><td><StatusBadge status={i.status} /></td><td>{i.mime_type}</td><td>{i.page_count ?? '—'}</td><td>{new Date(i.created_at).toLocaleString()}</td><td>{new Date(i.updated_at).toLocaleString()}</td></tr>)}</tbody></table>}
  </div>
}
