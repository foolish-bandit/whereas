import { useCallback, useRef, useState } from "react";

import { formatBytes, mimeLabel } from "../lib/format";
import {
  ACCEPTED_EXTENSIONS,
  ACCEPTED_MIME,
  UPLOAD_MAX_BYTES,
  validateFile,
} from "../lib/upload";

export interface UploadDropzoneProps {
  file: File | null;
  onFileSelected: (file: File | null) => void;
  disabled?: boolean;
}

export default function UploadDropzone({
  file,
  onFileSelected,
  disabled,
}: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const next = files[0];
      const err = validateFile(next);
      if (err) {
        setValidationError(err);
        onFileSelected(null);
        return;
      }
      setValidationError(null);
      onFileSelected(next);
    },
    [onFileSelected],
  );

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (disabled) return;
    handleFiles(e.dataTransfer.files);
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!disabled) setDragActive(true);
  }

  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
  }

  function onClickBrowse() {
    if (disabled) return;
    inputRef.current?.click();
  }

  function onClear() {
    setValidationError(null);
    onFileSelected(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div>
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={[
          "rounded-lg border-2 border-dashed bg-canvas px-6 py-10 text-center transition-colors",
          dragActive
            ? "border-accent-ring bg-canvas-subtle"
            : "border-rule-strong",
          disabled ? "opacity-60" : "",
        ].join(" ")}
      >
        <p className="text-sm font-medium text-ink">
          Drop a contract here, or
          <button
            type="button"
            onClick={onClickBrowse}
            disabled={disabled}
            className="ml-1 text-accent underline-offset-2 hover:underline"
          >
            browse files
          </button>
        </p>
        <p className="mt-2 text-xs text-ink-subtle">
          PDF or DOCX, up to {formatBytes(UPLOAD_MAX_BYTES)}.
        </p>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={[...ACCEPTED_EXTENSIONS, ...ACCEPTED_MIME].join(",")}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {validationError && (
        <p className="mt-3 text-sm text-danger">{validationError}</p>
      )}

      {file && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-rule bg-canvas px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{file.name}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">
              {mimeLabel(file.type || "application/octet-stream")} ·{" "}
              {formatBytes(file.size)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="ml-4 shrink-0 rounded border border-rule px-2.5 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
