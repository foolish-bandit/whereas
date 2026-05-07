import { useState } from 'react'
import { setDevUserId } from '../lib/devUser'

export function SettingsPage({ devUserId, onSaved }: { devUserId: string; onSaved: (id: string) => void }) {
  const [value, setValue] = useState(devUserId)
  return <div className='max-w-xl space-y-3'>
    <h2 className='text-xl font-semibold'>Development User ID</h2>
    <input className='w-full rounded border p-2' value={value} onChange={(e)=>setValue(e.target.value)} placeholder='UUID' />
    <button className='rounded bg-slate-900 px-3 py-2 text-white' onClick={() => { setDevUserId(value); onSaved(value.trim()) }}>Save</button>
  </div>
}
