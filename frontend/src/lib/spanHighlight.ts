export function getHighlightSegments(text: string, start: number | null, end: number | null) {
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (start < 0 || end <= start || end > text.length) return null
  return { before: text.slice(0, start), highlight: text.slice(start, end), after: text.slice(end) }
}
