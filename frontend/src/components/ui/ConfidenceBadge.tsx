export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const level = confidence >= 0.85 ? 'high' : confidence >= 0.6 ? 'medium' : 'low'
  const color = level === 'high' ? 'bg-emerald-100 text-emerald-700' : level === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'
  return <span className={`rounded px-2 py-1 text-xs ${color}`}>{level} ({Math.round(confidence * 100)}%)</span>
}
