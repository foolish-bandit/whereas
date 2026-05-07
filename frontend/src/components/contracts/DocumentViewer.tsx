import { useEffect, useRef } from 'react'
import { getHighlightSegments } from '../../lib/spanHighlight'

export function DocumentViewer({ text, start, end }: { text: string; start: number | null; end: number | null }) {
  const ref = useRef<HTMLElement | null>(null)
  const seg = getHighlightSegments(text, start, end)
  useEffect(() => { ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [start, end])
  return <div className='rounded border bg-white p-4 whitespace-pre-wrap leading-7 text-sm'>
    {seg ? <>{seg.before}<mark ref={ref} className='bg-yellow-200 px-0.5'>{seg.highlight}</mark>{seg.after}</> : text}
  </div>
}
