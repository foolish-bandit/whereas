/**
 * Canonical list of substrings that must NEVER appear in rendered DOM
 * across the app. Centralizes what individual page tests already check
 * piecemeal so the MVP-readiness audit (PR #107) and any future audit
 * tests can scan every route against the same allowlist without each
 * test re-deriving it.
 *
 * Categories:
 *   - storage / encryption internals      (storage_key, wrapped_dek, ...)
 *   - signed URL leakage                  (presigned*, private_url)
 *   - raw artifact slot tokens            (original_upload, generated_docx, ...)
 *   - raw metadata-bag spillover          (metadata_json)
 *   - DocuSeal secret leakage             (docuseal_webhook_secret, ...)
 *
 * Raw artifact slot tokens are listed because we always render the
 * humanized label via ``artifactDisplayLabel()``; if a regression ever
 * passes the raw enum value straight through to the DOM, this scan
 * catches it.
 */
export const FORBIDDEN_DOM_TOKENS: readonly string[] = [
  // Storage / encryption internals.
  "storage_key",
  "wrapped_dek",
  "wrapped_master_key",
  "s3_key",
  // Signed-URL leakage shapes.
  "presigned_url",
  "presigned_uri",
  "private_url",
  // Raw artifact slot tokens — these must always be humanized.
  "original_upload",
  "generated_docx",
  "signed_pdf",
  "redline_docx",
  // Raw metadata-bag spillover.
  "metadata_json",
  // DocuSeal secret-shaped fields.
  "docuseal_webhook_secret",
  "docuseal_api_token",
];

/**
 * Assert that none of the FORBIDDEN_DOM_TOKENS appear in the rendered
 * page text. Pass the active `document.body.textContent` (or any
 * substring of the DOM you want to scan).
 */
export function expectNoForbiddenTokens(text: string | null | undefined): void {
  const body = text ?? "";
  for (const needle of FORBIDDEN_DOM_TOKENS) {
    if (body.includes(needle)) {
      throw new Error(
        `Forbidden token "${needle}" appeared in rendered DOM. ` +
          `Storage internals, signed URLs, raw artifact tokens, and raw ` +
          `metadata_json must never reach the user.`,
      );
    }
  }
}
