import { useState } from "react";
import { Link } from "react-router-dom";

import ErrorState from "../components/ErrorState";
import UploadDropzone from "../components/UploadDropzone";
import UploadReviewPanel from "../components/UploadReviewPanel";
import {
  ApiError,
  MissingDevUserError,
  uploadContract,
} from "../lib/api";
import type { UploadContractResponse } from "../types/contracts";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: UploadContractResponse }
  | { kind: "error"; title: string; description: string };

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setState({ kind: "submitting" });
    try {
      const result = await uploadContract({ file, title });
      setState({ kind: "success", result });
    } catch (err) {
      if (err instanceof MissingDevUserError) {
        setState({
          kind: "error",
          title: "No development user ID configured",
          description:
            "Set a development user ID in Settings before uploading.",
        });
        return;
      }
      if (err instanceof ApiError) {
        setState({
          kind: "error",
          title: "Upload failed",
          description: err.message,
        });
        return;
      }
      setState({
        kind: "error",
        title: "Upload failed",
        description: "An unexpected error occurred.",
      });
    }
  }

  function reset() {
    setFile(null);
    setTitle("");
    setState({ kind: "idle" });
  }

  if (state.kind === "success") {
    const extractionFailed = state.result.message === "metadata_extraction_failed";
    return (
      <div>
        <h1 className="font-serif text-2xl text-ink">Upload</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The contract has been stored on this deployment.
        </p>

        <div className="mt-6 rounded-lg border border-success-ring bg-success-soft p-5">
          <p className="font-medium text-success">Contract uploaded.</p>
          <p className="mt-1 text-sm text-ink-muted">
            <span className="font-medium text-ink">{state.result.title}</span>{" "}
            · stored with id{" "}
            <span className="font-mono text-xs">{state.result.id}</span>
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link
              to={`/demo/repository/${state.result.id}`}
              className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring sm:w-auto sm:py-1.5"
            >
              Open in Repository
            </Link>
            <button
              type="button"
              onClick={reset}
              className="inline-flex w-full items-center justify-center rounded border border-rule bg-canvas px-3 py-2 text-sm font-medium text-ink hover:border-rule-strong sm:w-auto sm:py-1.5"
            >
              Upload another
            </button>
          </div>
        </div>

        {extractionFailed && (
          <div className="mt-4 rounded-lg border border-warning-ring bg-warning-soft p-5 text-sm text-warning">
            <p className="font-medium">
              Contract uploaded, but metadata extraction failed.
            </p>
            <p className="mt-1 text-ink-muted">
              The original file is stored and downloadable. You can retry
              extraction later from the contract workspace once that flow is
              wired up.
            </p>
          </div>
        )}

        <UploadReviewPanel
          contract={{ id: state.result.id, title: state.result.title }}
          extractedMetadata={state.result.extracted_metadata}
          duplicateCandidates={state.result.duplicate_candidates}
          context="repository_upload"
          dataTestId="upload-page-review-panel"
        />
      </div>
    );
  }

  return (
    <div>
      <h1 className="font-serif text-2xl text-ink">Upload</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Whereas accepts PDF and DOCX files. Documents stay on this deployment;
        nothing is sent anywhere except the configured backend API.
      </p>

      <form
        onSubmit={onSubmit}
        className="mt-6 max-w-3xl space-y-5"
      >
        <UploadDropzone
          file={file}
          onFileSelected={setFile}
          disabled={state.kind === "submitting"}
        />

        <div>
          <label
            htmlFor="contract-title"
            className="block text-sm font-medium text-ink"
          >
            Title (optional)
          </label>
          <input
            id="contract-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Defaults to the file name"
            disabled={state.kind === "submitting"}
            className="mt-1 w-full rounded border border-rule bg-canvas px-3 py-1.5 text-sm placeholder:text-ink-subtle focus:border-accent-ring focus:outline-none"
            maxLength={500}
          />
        </div>

        {state.kind === "error" && (
          <ErrorState
            title={state.title}
            description={state.description}
          />
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="submit"
            disabled={!file || state.kind === "submitting"}
            className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-4 py-2 text-sm font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:py-1.5"
          >
            {state.kind === "submitting" ? "Uploading…" : "Upload contract"}
          </button>
          {state.kind === "submitting" && (
            <span className="text-xs text-ink-muted">
              Storing the file and running metadata extraction. This can take a
              moment.
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
