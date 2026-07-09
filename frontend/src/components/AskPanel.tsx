import { useState } from "react";

import { ApiError, MissingDevUserError, askQuestion } from "../lib/api";
import type { AskCitation, AskResponse } from "../types/qa";
import ConfidenceBadge from "./ConfidenceBadge";

interface AskPanelProps {
  /**
   * Scopes the question to a single contract's clauses. Omit to search
   * across every contract the current user can read.
   */
  contractId?: string | null;
  /**
   * Called when the user clicks a citation card. Callers embedded in
   * the contract workspace use this to highlight the cited span in
   * `DocumentViewer`. `startOffset` / `endOffset` are offsets into the
   * cited clause's own text, matching `AskCitation`.
   */
  onCitationSelect?: (
    clauseId: string,
    startOffset: number,
    endOffset: number,
  ) => void;
}

type AskState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; response: AskResponse }
  | { kind: "error"; message: string };

const UNAVAILABLE_MESSAGE =
  "The question-answering assistant is temporarily unavailable. Try again in a moment.";

export default function AskPanel({
  contractId = null,
  onCitationSelect,
}: AskPanelProps) {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<AskState>({ kind: "idle" });

  const trimmed = question.trim();
  const isLoading = state.kind === "loading";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || isLoading) return;
    setState({ kind: "loading" });
    try {
      const response = await askQuestion({
        question: trimmed,
        contract_id: contractId,
      });
      setState({ kind: "loaded", response });
    } catch (err) {
      if (err instanceof MissingDevUserError) {
        setState({ kind: "error", message: err.message });
        return;
      }
      if (err instanceof ApiError) {
        setState({
          kind: "error",
          message: err.status === 503 ? UNAVAILABLE_MESSAGE : err.message,
        });
        return;
      }
      setState({ kind: "error", message: "Could not get an answer." });
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      <div className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">Ask</h2>
        <p className="mt-0.5 text-xs text-ink-subtle">
          Questions are answered only from indexed contract text, with a
          citation for every claim. Whereas surfaces information about
          contracts; it does not provide legal advice.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-2 px-4 py-3">
        <label className="block text-xs text-ink-muted">
          <span className="mb-1 block text-ink-subtle">Question</span>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={isLoading}
            maxLength={2000}
            rows={3}
            placeholder="e.g. What is the termination notice period?"
            className="w-full rounded border border-rule bg-canvas px-2 py-1.5 text-sm text-ink disabled:opacity-60"
            aria-label="Question"
          />
        </label>
        <button
          type="submit"
          disabled={!trimmed || isLoading}
          className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-xs font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:py-1.5"
        >
          {isLoading ? "Asking…" : "Ask"}
        </button>
      </form>

      <div className="border-t border-rule px-4 py-3">
        <AskResultArea state={state} onCitationSelect={onCitationSelect} />
      </div>
    </div>
  );
}

interface AskResultAreaProps {
  state: AskState;
  onCitationSelect?: (
    clauseId: string,
    startOffset: number,
    endOffset: number,
  ) => void;
}

function AskResultArea({ state, onCitationSelect }: AskResultAreaProps) {
  if (state.kind === "idle") {
    return (
      <p className="text-xs text-ink-subtle">
        Ask a question about this contract to get a cited answer.
      </p>
    );
  }
  if (state.kind === "loading") {
    return <p className="text-xs text-ink-subtle">Asking…</p>;
  }
  if (state.kind === "error") {
    return (
      <p className="text-xs text-danger" data-testid="ask-panel-error">
        {state.message}
      </p>
    );
  }
  const { response } = state;
  if (!response.answerable) {
    return (
      <div
        className="rounded border border-rule bg-canvas-subtle px-3 py-2"
        data-testid="ask-panel-refusal"
      >
        <p className="text-xs font-medium text-ink">
          No supported answer found in your documents.
        </p>
        <p className="mt-1 text-xs text-ink-subtle">{response.answer}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="ask-panel-answer">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-ink">{response.answer}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ConfidenceBadge confidence={response.confidence} />
        {response.model && (
          <span className="text-[11px] text-ink-subtle">
            Model: {response.model}
          </span>
        )}
      </div>
      <ul className="space-y-2">
        {response.citations.map((citation, i) => (
          <CitationCard
            key={`${citation.clause_id}-${citation.start_offset}-${i}`}
            citation={citation}
            onSelect={onCitationSelect}
          />
        ))}
      </ul>
    </div>
  );
}

const QUOTE_PREVIEW_MAX = 180;

function CitationCard({
  citation,
  onSelect,
}: {
  citation: AskCitation;
  onSelect?: (
    clauseId: string,
    startOffset: number,
    endOffset: number,
  ) => void;
}) {
  const quotePreview =
    citation.quote.length > QUOTE_PREVIEW_MAX
      ? `${citation.quote.slice(0, QUOTE_PREVIEW_MAX - 1).trimEnd()}…`
      : citation.quote;
  return (
    <li>
      <button
        type="button"
        onClick={() =>
          onSelect?.(
            citation.clause_id,
            citation.start_offset,
            citation.end_offset,
          )
        }
        disabled={!onSelect}
        className="block w-full rounded border border-rule bg-canvas-subtle px-2.5 py-2 text-left text-xs transition-colors hover:bg-canvas-muted disabled:cursor-default disabled:hover:bg-canvas-subtle"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium text-ink">
            {citation.contract_title}
          </span>
        </div>
        {citation.heading && (
          <div className="mt-0.5 text-[11px] text-ink-subtle">
            {citation.heading}
          </div>
        )}
        <div className="mt-1 line-clamp-3 text-ink-muted">
          &ldquo;{quotePreview}&rdquo;
        </div>
        {onSelect && (
          <div className="mt-1 text-[10px] text-ink-subtle">
            Click to highlight in document
          </div>
        )}
      </button>
    </li>
  );
}
