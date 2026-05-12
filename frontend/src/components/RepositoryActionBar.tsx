import { useEffect, useRef, useState } from "react";

import {
  REPOSITORY_FOLDERS,
  type RepositoryFolder,
} from "../lib/repositoryFolders";
import type { ContractListItem } from "../types/contracts";

interface RepositoryActionBarProps {
  selectedRows: ContractListItem[];
  knownTags: string[];
  onApplyTag: (tag: string) => void;
  onArchive: () => void;
  onMoveToFolder: (folder: RepositoryFolder) => void;
  onExportCsv: () => void;
  onCancel: () => void;
}

function useDismiss(ref: React.RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [ref, onClose]);
}

export default function RepositoryActionBar({
  selectedRows,
  knownTags,
  onApplyTag,
  onArchive,
  onMoveToFolder,
  onExportCsv,
  onCancel,
}: RepositoryActionBarProps) {
  const [tagOpen, setTagOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [newTagDraft, setNewTagDraft] = useState("");
  const tagRef = useRef<HTMLDivElement>(null);
  const moveRef = useRef<HTMLDivElement>(null);

  useDismiss(tagRef, () => setTagOpen(false));
  useDismiss(moveRef, () => setMoveOpen(false));

  const count = selectedRows.length;

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2 rounded border border-info-ring bg-info-soft px-3 py-2 text-sm"
      role="toolbar"
      aria-label="Bulk actions on selected rows"
      data-testid="repository-action-bar"
    >
      <span
        className="font-medium text-ink"
        data-testid="repository-action-bar-count"
      >
        {count} selected
      </span>

      <div ref={tagRef} className="relative">
        <button
          type="button"
          onClick={() => setTagOpen((v) => !v)}
          className="rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink hover:border-rule-strong"
          data-testid="repository-action-tag"
          aria-haspopup="menu"
          aria-expanded={tagOpen}
        >
          Tag ▾
        </button>
        {tagOpen && (
          <div
            className="absolute left-0 z-10 mt-1 w-56 rounded border border-rule bg-canvas py-1 shadow-md"
            role="menu"
            data-testid="repository-action-tag-menu"
          >
            {knownTags.length === 0 && (
              <p className="px-3 py-1.5 text-xs text-ink-subtle">
                No tags yet.
              </p>
            )}
            {knownTags.map((t) => (
              <button
                key={t}
                type="button"
                role="menuitem"
                onClick={() => {
                  onApplyTag(t);
                  setTagOpen(false);
                }}
                className="block w-full px-3 py-1 text-left text-xs text-ink hover:bg-canvas-subtle"
                data-testid={`repository-action-tag-existing-${t}`}
              >
                #{t}
              </button>
            ))}
            <form
              className="border-t border-rule px-2 py-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const tag = newTagDraft.trim().toLowerCase().replace(/\s+/g, "-");
                if (tag.length === 0) return;
                onApplyTag(tag);
                setNewTagDraft("");
                setTagOpen(false);
              }}
            >
              <input
                type="text"
                value={newTagDraft}
                onChange={(e) => setNewTagDraft(e.target.value)}
                placeholder="New tag…"
                className="w-full rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink focus:border-accent-ring focus:outline-none"
                data-testid="repository-action-tag-new-input"
              />
            </form>
          </div>
        )}
      </div>

      {confirmArchive ? (
        <div
          className="flex items-center gap-2"
          data-testid="repository-action-archive-confirm"
        >
          <span className="text-xs text-ink-muted">Archive {count}?</span>
          <button
            type="button"
            onClick={() => {
              onArchive();
              setConfirmArchive(false);
            }}
            className="rounded border border-danger bg-danger px-2 py-1 text-xs font-medium text-canvas hover:opacity-90"
            data-testid="repository-action-archive-commit"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={() => setConfirmArchive(false)}
            className="rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink hover:border-rule-strong"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmArchive(true)}
          className="rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink hover:border-rule-strong"
          data-testid="repository-action-archive"
        >
          Archive
        </button>
      )}

      <button
        type="button"
        onClick={onExportCsv}
        className="rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink hover:border-rule-strong"
        data-testid="repository-action-export"
      >
        Export
      </button>

      <div ref={moveRef} className="relative">
        <button
          type="button"
          onClick={() => setMoveOpen((v) => !v)}
          className="rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink hover:border-rule-strong"
          data-testid="repository-action-move"
          aria-haspopup="menu"
          aria-expanded={moveOpen}
        >
          Move ▾
        </button>
        {moveOpen && (
          <div
            className="absolute left-0 z-10 mt-1 w-48 rounded border border-rule bg-canvas py-1 shadow-md"
            role="menu"
            data-testid="repository-action-move-menu"
          >
            {REPOSITORY_FOLDERS.map((f) => (
              <button
                key={f}
                type="button"
                role="menuitem"
                onClick={() => {
                  onMoveToFolder(f);
                  setMoveOpen(false);
                }}
                className="block w-full px-3 py-1 text-left text-xs text-ink hover:bg-canvas-subtle"
                data-testid={`repository-action-move-${f.toLowerCase()}`}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="ml-auto rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink-muted hover:text-ink"
        data-testid="repository-action-cancel"
      >
        Cancel
      </button>
    </div>
  );
}
