import { useEffect, useId, useRef, useState } from "react";

export interface RepositoryClassificationValues {
  name: string;
  contractType: string;
  status: string;
  owner: string;
  folder: string;
}

interface Props {
  open: boolean;
  selectedCount: number;
  demoMode: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: RepositoryClassificationValues) => void | Promise<void>;
  /**
   * Real-mode primary action: link/button rendered in place of the
   * demo "Route to Repository" button. The page-level caller decides
   * what this is (typically a `<Link>` to /upload). Kept as a render
   * prop so the modal stays purely presentational and avoids pulling
   * router knowledge into a leaf component.
   */
  realModeActionSlot?: React.ReactNode;
}

/**
 * PR #114 — Repository settings / classification modal.
 *
 * Routed from Inbox → Move to Repository. Mirrors the kind of
 * lightweight classification step Summize-style intake products
 * surface before a contract lands in the repository. Kept narrow:
 *
 *   • Repository name + Contract type map to fields the backend
 *     already understands (Contract.title, Contract.contract_type)
 *     and are safe in both modes.
 *   • Status / Owner / Folder are demo-only conveniences. They are
 *     captured for the demo move but are NOT sent to the server in
 *     real mode — the real-mode path links out to the existing
 *     Repository upload / metadata-confirmation flow so we never
 *     fake a server mutation that doesn't exist.
 *
 * Approval tasks must never reach this modal; the parent gates that.
 */
export default function RepositoryClassificationModal(props: Props) {
  const {
    open,
    selectedCount,
    demoMode,
    busy,
    onCancel,
    onSubmit,
    realModeActionSlot,
  } = props;

  const titleId = useId();
  const [name, setName] = useState("");
  const [contractType, setContractType] = useState("");
  const [status, setStatus] = useState("Draft");
  const [owner, setOwner] = useState("");
  const [folder, setFolder] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setNameError(null);
    nameInputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  function handleSubmit() {
    const trimmedName = name.trim();
    if (demoMode && !trimmedName) {
      setNameError("Repository name is required.");
      nameInputRef.current?.focus();
      return;
    }
    setNameError(null);
    void onSubmit({
      name: trimmedName,
      contractType: contractType.trim(),
      status,
      owner: owner.trim(),
      folder: folder.trim(),
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="repository-classification-modal"
    >
      <div className="w-full max-w-xl rounded border border-rule bg-canvas p-5 text-sm text-ink shadow-xl">
        <h2
          id={titleId}
          className="text-base font-semibold text-ink"
          data-testid="repository-classification-modal-title"
        >
          Repository settings
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          {selectedCount === 1
            ? "Classify 1 inbox item before it lands in the Repository."
            : `Classify ${selectedCount} inbox items before they land in the Repository.`}
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-ink-muted sm:col-span-2">
            <span>
              Repository name
              <span aria-hidden="true" className="text-danger"> *</span>
            </span>
            <input
              ref={nameInputRef}
              className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="repo-classify-name"
              aria-invalid={nameError ? "true" : "false"}
              aria-describedby={nameError ? `${titleId}-name-error` : undefined}
            />
            {nameError && (
              <span
                id={`${titleId}-name-error`}
                className="block text-xs text-danger"
                data-testid="repo-classify-name-error"
              >
                {nameError}
              </span>
            )}
          </label>
          <label className="space-y-1 text-xs text-ink-muted">
            <span>Contract type</span>
            <input
              className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={contractType}
              onChange={(e) => setContractType(e.target.value)}
              placeholder="e.g. NDA, MSA, SOW"
              data-testid="repo-classify-contract-type"
            />
          </label>
          <label className="space-y-1 text-xs text-ink-muted">
            <span>Status</span>
            <select
              className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              data-testid="repo-classify-status"
            >
              <option value="Draft">Draft</option>
              <option value="In review">In review</option>
              <option value="Ready">Ready</option>
              <option value="Executed">Executed</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-ink-muted">
            <span>Owner</span>
            <input
              className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="Name or email"
              data-testid="repo-classify-owner"
            />
          </label>
          <label className="space-y-1 text-xs text-ink-muted">
            <span>Folder / category</span>
            <input
              className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="e.g. Sales / EMEA"
              data-testid="repo-classify-folder"
            />
          </label>
        </div>

        {!demoMode && (
          <p
            className="mt-4 rounded border border-info-ring bg-info-soft px-3 py-2 text-xs text-info"
            data-testid="repo-classify-real-note"
          >
            Repository routing from Inbox uses the existing Repository upload
            and metadata-confirmation flow. Status, owner, and folder fields
            shown here are workflow conveniences — they aren&apos;t saved to
            the server from this dialog. Continue to Repository upload to
            classify the document there.
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded border border-rule bg-canvas px-3 py-1 text-xs text-ink hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onCancel}
            disabled={busy}
            data-testid="repo-classify-cancel"
          >
            Cancel
          </button>
          {demoMode ? (
            <button
              type="button"
              className="rounded border border-ink bg-ink px-3 py-1 text-xs font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleSubmit}
              disabled={busy}
              data-testid="repo-classify-submit"
            >
              {busy ? "Routing…" : "Route to Repository"}
            </button>
          ) : (
            realModeActionSlot
          )}
        </div>
      </div>
    </div>
  );
}
