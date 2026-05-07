export function validateUploadFile(file: File | null): string | null {
  if (!file) return 'Choose a file first.'
  if (!/\.(pdf|docx)$/i.test(file.name)) return 'Unsupported extension. Use PDF or DOCX.'
  return null
}
