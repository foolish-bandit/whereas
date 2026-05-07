import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { downloadContract, getContract } from '../lib/api'
import { DocumentViewer } from '../components/contracts/DocumentViewer'
import { MetadataPanel } from '../components/contracts/MetadataPanel'
import { StatusBadge } from '../components/ui/StatusBadge'
import type { ContractDetail } from '../types/contracts'

export function ContractDetailPage({ devUserId }: { devUserId: string }) {
  const { id = '' } = useParams(); const [data, setData] = useState<ContractDetail | null>(null); const [error, setError] = useState(''); const [selected, setSelected] = useState(0)
  useEffect(()=>{ if (!devUserId) return; getContract(id, devUserId).then(setData).catch(e=>setError(e.message)) }, [id, devUserId])
  if (!devUserId) return <div className='rounded border border-amber-200 bg-amber-50 p-3 text-sm'>Set a development user ID to call the local API.</div>
  if (error) return <div className='rounded border border-rose-200 bg-rose-50 p-3 text-sm'>{error}</div>
  if (!data) return <div className='rounded border bg-white p-4 text-sm'>Loading contract…</div>
  const field = data.extracted_fields[selected]
  const download = async () => { const blob = await downloadContract(data.id, devUserId); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = data.title.replace(/[^a-z0-9._-]/gi,'_') + (data.mime_type.includes('pdf') ? '.pdf' : '.docx'); a.click(); URL.revokeObjectURL(url) }
  return <div className='space-y-4'>
    <div className='rounded border bg-white p-4'><div className='flex items-center justify-between'><div><h2 className='text-xl font-semibold'>{data.title}</h2><div className='mt-1 text-xs text-slate-600'>{data.mime_type} · {data.page_count ?? '—'} pages</div></div><div className='flex items-center gap-2'><StatusBadge status={data.status} /><button className='rounded border px-3 py-1 text-sm' onClick={download}>Download original</button></div></div></div>
    <div className='grid grid-cols-[1fr_340px] gap-4'><DocumentViewer text={data.full_text ?? 'No extracted text available.'} start={field?.span_start ?? null} end={field?.span_end ?? null} /><MetadataPanel fields={data.extracted_fields} selected={selected} onSelect={setSelected} textLength={(data.full_text ?? '').length} /></div>
  </div>
}
