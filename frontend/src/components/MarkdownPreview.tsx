/**
 * MarkdownPreview renders the lightweight Markdown working snapshot
 * for a contract. The DOCX/PDF the user uploaded is the official
 * legal artifact; this preview is a fast working copy used for
 * reading, search, and analysis.
 *
 * The component is deliberately self-contained:
 * - It owns the loading / loaded / empty / error states.
 * - It does not cross-link with the highlight pipeline used by the
 *   plain-text DocumentViewer; the markdown view is for reading, the
 *   plain-text view is for span citations.
 * - All Markdown rendering goes through ``renderMarkdown``, which
 *   never uses ``dangerouslySetInnerHTML``.
 */
import { useEffect, useState } from "react";

import {
  ApiError,
  MissingDevUserError,
  getContractMarkdown,
} from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import type { ContractMarkdownSnapshot } from "../types/contracts";

interface MarkdownPreviewProps {
  contractId: string;
  /**
   * Renders an action (typically a button) next to the title that
   * lets the user switch to the original document text view. Optional
   * because some surfaces may not need it.
   */
  rightSlot?: React.ReactNode;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; snapshot: ContractMarkdownSnapshot | null }
  | { kind: "error"; message: string };

export default function MarkdownPreview({
  contractId,
  rightSlot,
}: MarkdownPreviewProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    getContractMarkdown(contractId, { signal: controller.signal })
      .then((snapshot) => setState({ kind: "loaded", snapshot }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof MissingDevUserError) {
          setState({ kind: "error", message: err.message });
          return;
        }
        if (err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
          return;
        }
        setState({
          kind: "error",
          message: "Could not load the markdown preview.",
        });
      });
    return () => controller.abort();
  }, [contractId]);

  return (
    <div
      className="overflow-hidden rounded-lg border border-rule bg-canvas"
      data-testid="markdown-preview"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink">Markdown preview</h2>
          <p className="mt-0.5 text-xs text-ink-subtle">
            Lightweight working copy. The original DOCX/PDF remains the
            official legal artifact.
          </p>
        </div>
        {rightSlot && (
          <div className="flex items-center gap-2">{rightSlot}</div>
        )}
      </div>

      {state.kind === "loading" && (
        <div className="px-6 py-6 text-sm text-ink-muted">
          Loading markdown preview…
        </div>
      )}

      {state.kind === "error" && (
        <div className="px-6 py-6 text-sm text-danger">{state.message}</div>
      )}

      {state.kind === "loaded" && state.snapshot === null && (
        <EmptyPreviewState />
      )}

      {state.kind === "loaded" && state.snapshot !== null && (
        <SnapshotBody snapshot={state.snapshot} />
      )}
    </div>
  );
}

function SnapshotBody({ snapshot }: { snapshot: ContractMarkdownSnapshot }) {
  const created = formatTimestamp(snapshot.created_at);
  const warnings = (snapshot.conversion_warnings ?? []).map((w) => String(w));
  return (
    <>
      <div className="border-b border-rule bg-canvas px-4 py-2 text-[11px] text-ink-subtle">
        <span data-testid="markdown-meta">
          Converter <span className="text-ink-muted">{snapshot.converter_name}</span>
          {snapshot.converter_version
            ? ` (${snapshot.converter_version})`
            : ""}
          {created ? ` · generated ${created}` : ""}
        </span>
      </div>
      {warnings.length > 0 && (
        <div
          className="border-b border-warning-ring bg-warning-soft px-4 py-2 text-xs text-warning"
          data-testid="markdown-warnings"
        >
          <p className="font-medium">Conversion notes</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="max-h-[70vh] overflow-y-auto px-4 py-4 sm:px-6 sm:py-5 lg:max-h-[calc(100vh-13rem)]">
        <article
          className="font-serif text-ink"
          data-testid="markdown-body"
        >
          {renderMarkdown(snapshot.markdown_text)}
        </article>
      </div>
    </>
  );
}

function EmptyPreviewState() {
  return (
    <div
      className="px-6 py-6 text-sm text-ink-muted"
      data-testid="markdown-empty-state"
    >
      <p>No markdown preview is available for this contract yet.</p>
      <p className="mt-2 text-xs text-ink-subtle">
        This can happen when the document was uploaded before the
        markdown pipeline was added, or when conversion did not produce
        usable output. The original file is still downloadable from
        the contract header.
      </p>
    </div>
  );
}

function formatTimestamp(iso: string): string | null {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return null;
  }
}
