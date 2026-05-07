import { describe, expect, it } from 'vitest'
import { validateUploadFile } from './uploadValidation'

describe('validateUploadFile', () => {
  it('accepts pdf/docx', () => {
    expect(validateUploadFile(new File(['x'], 'a.pdf'))).toBeNull()
    expect(validateUploadFile(new File(['x'], 'a.docx'))).toBeNull()
  })
  it('rejects unsupported', () => {
    expect(validateUploadFile(new File(['x'], 'a.txt'))).toContain('Unsupported')
  })
})
