import type { ContractDetail, ContractListItem, UploadContractResponse } from '../types/contracts'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request(path: string, init: RequestInit = {}, devUserId?: string) {
  const headers = new Headers(init.headers)
  if (devUserId) headers.set('X-Whereas-Dev-User', devUserId)
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const data = await response.json()
      if (typeof data?.detail === 'string') message = data.detail
      else if (typeof data?.detail?.message === 'string') message = data.detail.message
    } catch {
      // ignore parse errors
    }
    throw new ApiError(response.status, message)
  }
  return response
}

export async function getContracts(devUserId: string): Promise<ContractListItem[]> {
  const res = await request('/api/contracts', {}, devUserId)
  return res.json()
}

export async function getContract(id: string, devUserId: string): Promise<ContractDetail> {
  const res = await request(`/api/contracts/${id}`, {}, devUserId)
  return res.json()
}

export async function uploadContract(args: { file: File; title?: string; devUserId: string }): Promise<UploadContractResponse> {
  const form = new FormData()
  form.append('file', args.file)
  if (args.title?.trim()) form.append('title', args.title.trim())
  const res = await request('/api/contracts/upload', { method: 'POST', body: form }, args.devUserId)
  return res.json()
}

export async function downloadContract(id: string, devUserId: string): Promise<Blob> {
  const res = await request(`/api/contracts/${id}/download`, {}, devUserId)
  return res.blob()
}
