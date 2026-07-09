/**
 * Types mirroring `backend/app/schemas/qa.py` (`POST /api/qa/ask`).
 *
 * Per design principle #2 (span citations are mandatory), `AskResponse`
 * has no path that surfaces free-text answer content without at least
 * one citation that has been verified, verbatim, against the source
 * clause. `answerable: false` is the explicit "we could not cite this"
 * refusal shape, not an error.
 */

export interface AskRequest {
  question: string;
  /** Optional scope: when set, retrieval only considers this contract. */
  contract_id?: string | null;
}

/**
 * One validated citation backing an answer. `start_offset` /
 * `end_offset` are offsets into the *cited clause's* text (not the
 * full document) — mirrors `app.api.qa._validate_citations`, which
 * finds the quote inside `hit.text`.
 */
export interface AskCitation {
  contract_id: string;
  contract_title: string;
  clause_id: string;
  heading: string | null;
  quote: string;
  start_offset: number;
  end_offset: number;
}

export interface AskResponse {
  answerable: boolean;
  answer: string;
  citations: AskCitation[];
  confidence: number;
  model: string | null;
}
