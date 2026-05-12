import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";

import type { DocumentVersion } from "../types/demoExtras";
import { formatDateTime } from "../lib/format";

interface VersionDiffPaneProps {
  base: DocumentVersion;
  against: DocumentVersion;
  onClose: () => void;
}

// Override the library's default green/red with the existing color
// tokens. Keys come from react-diff-viewer-continued's `styles` prop.
const STYLES = {
  variables: {
    light: {
      // Subtle backgrounds that match Whereas's success/danger soft tokens.
      addedBackground: "#ecfdf5",
      addedColor: "#111827",
      removedBackground: "#fef2f2",
      removedColor: "#111827",
      wordAddedBackground: "#a7f3d0",
      wordRemovedBackground: "#fecaca",
      gutterBackground: "#f9fafb",
      gutterColor: "#6b7280",
      diffViewerBackground: "#ffffff",
      diffViewerColor: "#111827",
      codeFoldBackground: "#f3f4f6",
      emptyLineBackground: "#fafafa",
    },
  },
  contentText: {
    fontFamily:
      "'Iowan Old Style', 'Palatino Linotype', Georgia, serif",
    fontSize: "14px",
    lineHeight: "1.55",
  },
};

export default function VersionDiffPane({
  base,
  against,
  onClose,
}: VersionDiffPaneProps) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-rule bg-canvas"
      data-testid="version-diff-pane"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink">
            Diff:{" "}
            <span className="text-ink-subtle">{base.version_label}</span>{" "}
            →{" "}
            <span className="text-ink-subtle">{against.version_label}</span>
          </h2>
          <p className="mt-0.5 text-xs text-ink-subtle">
            Word-level diff. {formatDateTime(base.uploaded_at)} ·{" "}
            {base.uploaded_by_display_name} vs.{" "}
            {formatDateTime(against.uploaded_at)} ·{" "}
            {against.uploaded_by_display_name}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-rule bg-canvas px-2.5 py-1 text-xs text-ink hover:border-rule-strong"
          data-testid="version-diff-close"
        >
          Close diff
        </button>
      </div>
      <div className="max-h-mobile-viewer overflow-y-auto px-3 py-3 lg:max-h-[calc(100vh-13rem)]">
        <ReactDiffViewer
          oldValue={base.text_preview}
          newValue={against.text_preview}
          splitView
          compareMethod={DiffMethod.WORDS_WITH_SPACE}
          useDarkTheme={false}
          styles={STYLES}
          leftTitle={base.version_label}
          rightTitle={against.version_label}
        />
      </div>
    </div>
  );
}
