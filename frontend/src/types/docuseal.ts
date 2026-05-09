/**
 * Request/response types for the DocuSeal send flow. The backend
 * decrypts the artifact and POSTs it to DocuSeal as base64; the
 * client only sees this opaque submission projection.
 */
export interface DocuSealSigner {
  email: string;
  name: string;
  role?: string;
}

export interface SendContractToDocuSealRequest {
  signers: DocuSealSigner[];
}

export interface SendContractToDocuSealResponse {
  contract_id: string;
  artifact_id: string | null;
  artifact_type: string | null;
  filename: string | null;
  submission_id: string | null;
  status: string;
  embed_url: string | null;
  signer_count: number;
  raw: Record<string, unknown> | null;
}
