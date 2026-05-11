import { useRef, useState } from "react";

import { ApiError, convertRequestWithUpload } from "../lib/api";
import type {
  ContractRequest,
  ConvertRequestUploadResponse,
} from "../types/requests";

interface Props {
  request: ContractRequest;
  /** Hand the freshly-converted state back to the parent so it can swap
   *  the row state without re-fetching. */
  onConverted: (response: ConvertRequestUploadResponse) => void;
}

/**
 * Inline upload-conversion UI for a single request row (PR #65).
 *
 * The third-party / counterparty-paper intake path: the user uploads
 * an external agreement file and the request is converted into a
 * Repository contract. Collapsed by default behind a small toggle so
 * dense request lists stay readable.
 *
 * Rendered when the request has no ``linked_contract_id`` and is not
 * cancelled. Renders alongside the template-conversion section when
 * the request also has a ``linked_template_id`` — users see both intake
 * paths and pick whichever applies. The parent decides which guard
 * conditions apply; this component is just the form.
 */
export default function RequestUploadConvertSection({
  request,
  onConverted,
}: Props) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [counterparty, setCounterparty] = useState(
    request.counterparty_name ?? "",
  );
  const [contractType, setContractType] = useState(
    request.contract_type ?? "",
  );
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function reset(): void {
    setFile(null);
    setTitle("");
    setNotes("");
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onSubmit(): Promise<void> {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await convertRequestWithUpload(request.id, {
        file,
        title: title.trim() || null,
        counterparty_name: counterparty.trim() || null,
        contract_type: contractType.trim() || null,
        notes: notes.trim() || null,
      });
      onConverted(response);
      // Close the section + reset inputs so the now-completed row
      // doesn't keep its file picker primed for a second upload.
      setOpen(false);
      reset();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Could not upload the file.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-3" data-testid="request-upload-convert-section">
      {!open && (
        <button
          type="button"
          className="rounded border border-rule px-2 py-1 text-xs hover:bg-canvas-muted"
          onClick={() => setOpen(true)}
          data-testid="request-upload-convert-toggle"
        >
          Upload third-party agreement
        </button>
      )}
      {open && (
        <div
          className="grid gap-2 rounded border border-rule p-3 text-sm"
          data-testid="request-upload-convert-form"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-ink">
              Add a third-party agreement to Repository
            </p>
            <button
              type="button"
              className="text-xs text-ink-subtle underline hover:text-ink"
              onClick={() => {
                setOpen(false);
                reset();
              }}
              data-testid="request-upload-convert-cancel"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-ink-subtle">
            Upload the counterparty paper or signed exhibit attached to this
            request. The file becomes the official source file in the
            Repository and is linked back to this request.
          </p>

          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx"
            disabled={submitting}
            onChange={(e) => {
              const next = e.target.files?.[0] ?? null;
              setFile(next);
              if (!title && next?.name) {
                const stem = next.name.replace(/\.[^.]+$/, "");
                setTitle(stem);
              }
            }}
            data-testid="request-upload-convert-file"
          />

          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder={`Title (defaults to file name)`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="request-upload-convert-title"
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="rounded border border-rule px-2 py-1 text-sm"
              placeholder="Counterparty (optional)"
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              data-testid="request-upload-convert-counterparty"
            />
            <input
              className="rounded border border-rule px-2 py-1 text-sm"
              placeholder="Contract type (NDA, MSA, ...)"
              value={contractType}
              onChange={(e) => setContractType(e.target.value)}
              data-testid="request-upload-convert-type"
            />
          </div>
          <textarea
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Notes (optional, e.g. ‘Received via email 2026-05-10.’)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            data-testid="request-upload-convert-notes"
          />

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded border border-ink bg-ink px-3 py-1.5 text-sm text-canvas disabled:opacity-50"
              onClick={onSubmit}
              disabled={submitting || !file}
              data-testid="request-upload-convert-submit"
            >
              {submitting ? "Uploading…" : "Upload and add to Repository"}
            </button>
            {error && (
              <span
                className="text-xs text-danger"
                data-testid="request-upload-convert-error"
              >
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
