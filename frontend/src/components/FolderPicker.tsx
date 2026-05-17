import { useCallback, useEffect, useState } from "react";

import { listIntegrationFolders } from "../lib/api";
import type { FolderEntry } from "../types/integrations";

/**
 * Tree-browsing folder picker for the Integrations page.
 *
 * - Loads the root level on mount.
 * - Clicking a folder name navigates into it (lazy-loads children).
 * - Selection is independent of navigation: a click on the
 *   "Pick this folder" button confirms the current selection.
 * - Breadcrumb at the top lets the user climb back up without a full
 *   re-load when a level is already cached.
 *
 * The picker is provider-agnostic — it talks to a single backend
 * endpoint that dispatches to Google Drive / OneDrive internally.
 */

export interface FolderPickerProps {
  connectionId: string;
  providerLabel: string;
  initialFolderId: string | null;
  initialFolderName: string | null;
  onCancel: () => void;
  onPick: (folder: { id: string; name: string; path: string }) => Promise<void>;
  onClear: () => Promise<void>;
}

interface Crumb {
  id: string;
  name: string;
}

const ROOT_ID = "root";

export default function FolderPicker({
  connectionId,
  providerLabel,
  initialFolderId,
  initialFolderName,
  onCancel,
  onPick,
  onClear,
}: FolderPickerProps) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([
    { id: ROOT_ID, name: providerLabel },
  ]);
  const [children, setChildren] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(
    initialFolderId,
  );
  const [highlightedName, setHighlightedName] = useState<string | null>(
    initialFolderName,
  );

  const currentCrumb = crumbs[crumbs.length - 1];

  const loadLevel = useCallback(
    async (parentId: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listIntegrationFolders(connectionId, {
          parent_id: parentId,
        });
        setChildren(result.folders);
      } catch (err) {
        setChildren([]);
        setError(err instanceof Error ? err.message : "Could not load folders.");
      } finally {
        setLoading(false);
      }
    },
    [connectionId],
  );

  useEffect(() => {
    loadLevel(currentCrumb.id);
  }, [loadLevel, currentCrumb.id]);

  function enterFolder(folder: FolderEntry) {
    setCrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setHighlightedId(folder.id);
    setHighlightedName(buildPath([...crumbs, { id: folder.id, name: folder.name }]));
  }

  function jumpToCrumb(index: number) {
    setCrumbs((prev) => prev.slice(0, index + 1));
  }

  function selectFolder(folder: FolderEntry) {
    setHighlightedId(folder.id);
    setHighlightedName(buildPath([...crumbs, { id: folder.id, name: folder.name }]));
  }

  function selectCurrent() {
    if (currentCrumb.id === ROOT_ID) {
      // Picking the synthetic root means "clear the scope".
      setHighlightedId("");
      setHighlightedName(null);
      return;
    }
    setHighlightedId(currentCrumb.id);
    setHighlightedName(buildPath(crumbs));
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      if (!highlightedId) {
        await onClear();
        return;
      }
      await onPick({
        id: highlightedId,
        name: highlightedName ?? highlightedId,
        path: highlightedName ?? highlightedId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save folder.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-picker-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40"
      data-testid="folder-picker"
      onClick={(event) => {
        // Click on backdrop (not on dialog content) = cancel.
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-rule bg-canvas shadow-lg">
        <header className="border-b border-rule px-4 py-3">
          <h2
            id="folder-picker-title"
            className="text-sm font-semibold text-ink"
          >
            Pick a {providerLabel} folder to scope ingest
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            Only files in this folder (no subfolder recursion yet) will be
            imported. Pick the root to ingest the whole drive.
          </p>
        </header>

        <nav
          aria-label="Folder breadcrumb"
          className="border-b border-rule px-4 py-2 text-xs text-ink-muted"
          data-testid="folder-picker-crumbs"
        >
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            return (
              <span key={`${crumb.id}-${index}`}>
                {index > 0 && <span aria-hidden="true"> › </span>}
                {isLast ? (
                  <span className="font-medium text-ink">{crumb.name}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => jumpToCrumb(index)}
                    className="hover:text-ink underline-offset-2 hover:underline"
                    data-testid={`folder-picker-crumb-${index}`}
                  >
                    {crumb.name}
                  </button>
                )}
              </span>
            );
          })}
        </nav>

        <div
          className="max-h-72 overflow-y-auto px-4 py-2"
          data-testid="folder-picker-list"
        >
          {loading && (
            <p className="py-4 text-center text-xs text-ink-muted">Loading…</p>
          )}
          {!loading && error && (
            <p
              role="alert"
              className="py-2 text-xs text-danger"
              data-testid="folder-picker-error"
            >
              {error}
            </p>
          )}
          {!loading && !error && children.length === 0 && (
            <p className="py-4 text-center text-xs text-ink-muted">
              No subfolders here.
            </p>
          )}
          {!loading &&
            children.length > 0 &&
            children.map((folder) => {
              const isSelected = highlightedId === folder.id;
              return (
                <div
                  key={folder.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectFolder(folder)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectFolder(folder);
                    }
                  }}
                  onDoubleClick={() =>
                    folder.has_children ? enterFolder(folder) : selectFolder(folder)
                  }
                  className={`flex items-center justify-between gap-2 rounded px-2 py-1 ${
                    isSelected ? "bg-info-soft" : "hover:bg-canvas-muted"
                  }`}
                  data-testid={`folder-picker-row-${folder.id}`}
                >
                  <span className="flex-1 text-left text-xs text-ink">
                    <span aria-hidden="true" className="mr-1">📁</span>
                    {folder.name}
                  </span>
                  {folder.has_children && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        enterFolder(folder);
                      }}
                      className="rounded border border-rule px-1.5 py-0.5 text-xs text-ink-muted hover:bg-canvas"
                      data-testid={`folder-picker-open-${folder.id}`}
                      aria-label={`Open ${folder.name}`}
                    >
                      Open
                    </button>
                  )}
                </div>
              );
            })}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-4 py-3">
          <div className="text-xs text-ink-muted">
            <button
              type="button"
              onClick={selectCurrent}
              className="underline-offset-2 hover:underline"
              data-testid="folder-picker-select-current"
            >
              {currentCrumb.id === ROOT_ID
                ? "Use whole drive"
                : `Use this folder (${currentCrumb.name})`}
            </button>
            {highlightedName && (
              <p
                className="mt-1 text-xs text-ink"
                data-testid="folder-picker-selection"
              >
                Selected: <span className="font-medium">{highlightedName}</span>
              </p>
            )}
            {!highlightedName && highlightedId === "" && (
              <p
                className="mt-1 text-xs text-ink"
                data-testid="folder-picker-selection"
              >
                Selected: <span className="font-medium">Whole drive</span>
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium border border-rule text-ink hover:bg-canvas-muted disabled:opacity-60"
              data-testid="folder-picker-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || highlightedId === null}
              className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium bg-accent text-canvas hover:bg-accent/90 disabled:opacity-60 disabled:cursor-not-allowed"
              data-testid="folder-picker-save"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function buildPath(crumbs: Crumb[]): string {
  return crumbs
    .filter((c) => c.id !== ROOT_ID)
    .map((c) => c.name)
    .join(" › ");
}
