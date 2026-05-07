import type { ExtractedField } from '../../types/contracts'
import { ConfidenceBadge } from '../ui/ConfidenceBadge'

export function MetadataPanel({ fields, selected, onSelect, textLength }: { fields: ExtractedField[]; selected: number; onSelect: (i:number)=>void; textLength: number }) {
  return <div className='space-y-3'>
    <h3 className='text-sm font-semibold'>Extracted metadata</h3>
    <p className='text-xs text-slate-500'>Machine-generated fields must be reviewed by a human.</p>
    {fields.map((f, i) => {
      const valid = typeof f.span_start === 'number' && typeof f.span_end === 'number' && f.span_start >= 0 && f.span_end > f.span_start && f.span_end <= textLength
      return <button key={`${f.field_name}-${i}`} onClick={() => valid && onSelect(i)} className={`w-full rounded border p-3 text-left ${selected===i ? 'border-blue-400 bg-blue-50' : 'bg-white'}`}>
        <div className='mb-1 text-xs uppercase text-slate-500'>{f.field_name.replaceAll('_',' ')}</div>
        <div className='mb-2 text-sm font-medium break-words'>{String(f.value_json ?? '—')}</div>
        <div className='mb-2'><ConfidenceBadge confidence={f.confidence} /></div>
        <div className='text-xs text-slate-600'>{valid ? (f.span_text || 'Citation text unavailable') : 'Citation unavailable'}</div>
      </button>
    })}
  </div>
}
