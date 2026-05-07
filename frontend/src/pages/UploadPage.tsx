import { useState } from 'react'
import { Link } from 'react-router-dom'
import { uploadContract } from '../lib/api'
import type { UploadContractResponse } from '../types/contracts'
import { validateUploadFile } from '../lib/uploadValidation'

export function UploadPage({ devUserId }: { devUserId: string }) {
  const [file, setFile] = useState<File | null>(null); const [title, setTitle] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [result, setResult] = useState<UploadContractResponse | null>(null)
  const onUpload = async () => { const validation = validateUploadFile(file); if (validation) return setError(validation); if (!devUserId) return setError('Set a development user ID to call the local API.'); setError(''); setLoading(true); try { setResult(await uploadContract({ file, title, devUserId })) } catch(e){ setError((e as Error).message) } finally { setLoading(false) } }
  return <div className='max-w-2xl space-y-3'>
    <h2 className='text-xl font-semibold'>Upload contract</h2>
    <input className='w-full rounded border p-2' placeholder='Optional title' value={title} onChange={e=>setTitle(e.target.value)} />
    <div className='rounded border-2 border-dashed bg-white p-6'><input type='file' accept='.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document' onChange={e=>setFile(e.target.files?.[0] ?? null)} />{file && <p className='mt-2 text-sm'>{file.name} · {file.type || 'unknown'} · {Math.round(file.size/1024)} KB</p>}</div>
    <button onClick={onUpload} disabled={loading} className='rounded bg-slate-900 px-3 py-2 text-white'>{loading ? 'Uploading…' : 'Upload'}</button>
    {error && <div className='rounded border border-rose-200 bg-rose-50 p-3 text-sm'>{error}</div>}
    {result && <div className='rounded border border-emerald-200 bg-emerald-50 p-3 text-sm'>Uploaded. <Link className='underline' to={`/contracts/${result.id}`}>Open workspace</Link>{result.message==='metadata_extraction_failed' && <div className='mt-2 text-amber-700'>Contract uploaded, but metadata extraction failed.</div>}</div>}
  </div>
}
