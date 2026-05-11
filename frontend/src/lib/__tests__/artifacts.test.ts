import { describe, expect, it } from "vitest";

import {
  artifactDisplayLabel,
  artifactOriginCopy,
  artifactSourceChip,
  pickCurrentDocumentLabel,
  pickPrimaryOriginCopy,
} from "../artifacts";
import type { ContractArtifact } from "../../types/contracts";

function makeArtifact(over: Partial<ContractArtifact>): ContractArtifact {
  return {
    id: "art-1",
    contract_id: "c-1",
    artifact_type: "original_upload",
    storage_backend: "s3",
    filename: "agreement.pdf",
    mime_type: "application/pdf",
    file_hash_sha256: "0".repeat(64),
    size_bytes: 1024,
    source: "user_upload",
    is_official: true,
    created_at: "2026-05-01T00:00:00Z",
    metadata_json: null,
    ...over,
  };
}

describe("artifactDisplayLabel", () => {
  it("maps original_upload + user_upload to 'Source file'", () => {
    expect(artifactDisplayLabel("original_upload", "user_upload")).toBe(
      "Source file",
    );
  });

  it("maps original_upload + request_upload to 'Uploaded agreement'", () => {
    expect(artifactDisplayLabel("original_upload", "request_upload")).toBe(
      "Uploaded agreement",
    );
  });

  it("maps original_upload with unknown source to 'Source file'", () => {
    expect(artifactDisplayLabel("original_upload", null)).toBe("Source file");
    expect(artifactDisplayLabel("original_upload")).toBe("Source file");
  });

  it("maps generated_docx to 'Generated Word document'", () => {
    expect(artifactDisplayLabel("generated_docx")).toBe(
      "Generated Word document",
    );
  });

  it("maps signed_pdf to 'Signed PDF'", () => {
    expect(artifactDisplayLabel("signed_pdf")).toBe("Signed PDF");
  });

  it("maps redline / attachment to friendly labels", () => {
    expect(artifactDisplayLabel("redline")).toBe("Redline");
    expect(artifactDisplayLabel("attachment")).toBe("Attachment");
  });

  it("falls back to generic 'File' label for unknown artifact types", () => {
    expect(artifactDisplayLabel("future_thing")).toBe("File");
    // The raw enum identifier must not leak through.
    expect(artifactDisplayLabel("future_thing")).not.toMatch(/future_thing/);
  });
});

describe("pickCurrentDocumentLabel", () => {
  const signed = makeArtifact({
    id: "art-signed",
    artifact_type: "signed_pdf",
    filename: "executed.pdf",
    source: "docuseal",
  });
  const generated = makeArtifact({
    id: "art-gen",
    artifact_type: "generated_docx",
    filename: "draft.docx",
    source: "template_generation",
  });
  const original = makeArtifact({
    id: "art-orig",
    artifact_type: "original_upload",
    filename: "source.pdf",
    source: "user_upload",
  });

  it("prefers signed_pdf over generated_docx and original_upload", () => {
    const picked = pickCurrentDocumentLabel([signed, generated, original]);
    expect(picked).toEqual({ label: "Signed PDF", slot: "signed_pdf" });
  });

  it("prefers generated_docx over original_upload when no signed PDF exists", () => {
    const picked = pickCurrentDocumentLabel([generated, original]);
    expect(picked).toEqual({
      label: "Generated Word document",
      slot: "generated_docx",
    });
  });

  it("falls back to original_upload when nothing else is present", () => {
    const picked = pickCurrentDocumentLabel([original]);
    expect(picked).toEqual({ label: "Source file", slot: "original_upload" });
  });

  it("returns null when the artifact list is empty", () => {
    expect(pickCurrentDocumentLabel([])).toBeNull();
  });
});

describe("artifactOriginCopy / pickPrimaryOriginCopy", () => {
  it("returns DocuSeal copy for signed_pdf", () => {
    const a = makeArtifact({
      artifact_type: "signed_pdf",
      source: "docuseal",
      metadata_json: { docuseal_submission_id: "sub-1" },
    });
    expect(artifactOriginCopy(a)).toBe("Signed through DocuSeal");
  });

  it("includes template name when available for generated_docx", () => {
    const a = makeArtifact({
      artifact_type: "generated_docx",
      source: "template_generation",
      metadata_json: { template_id: "t-1", template_name: "Mutual NDA" },
    });
    expect(artifactOriginCopy(a)).toBe(
      "Generated from template “Mutual NDA”",
    );
  });

  it("falls back to a plain template label when name is missing", () => {
    const a = makeArtifact({
      artifact_type: "generated_docx",
      source: "template_generation",
      metadata_json: { template_id: "t-1" },
    });
    expect(artifactOriginCopy(a)).toBe("Generated from template");
  });

  it("marks request_upload original artifacts as converted from a request", () => {
    const a = makeArtifact({
      artifact_type: "original_upload",
      source: "request_upload",
      metadata_json: { request_id: "r-1", upload_source: "request_conversion" },
    });
    expect(artifactOriginCopy(a)).toBe("Converted from request upload");
  });

  it("marks user-uploaded originals as uploaded directly", () => {
    const a = makeArtifact({
      artifact_type: "original_upload",
      source: "user_upload",
    });
    expect(artifactOriginCopy(a)).toBe("Uploaded directly");
  });

  it("picks the highest-priority origin sentence", () => {
    const signed = makeArtifact({
      artifact_type: "signed_pdf",
      source: "docuseal",
    });
    const original = makeArtifact({
      artifact_type: "original_upload",
      source: "user_upload",
    });
    expect(pickPrimaryOriginCopy([signed, original])).toBe(
      "Signed through DocuSeal",
    );
    expect(pickPrimaryOriginCopy([original])).toBe("Uploaded directly");
    expect(pickPrimaryOriginCopy([])).toBeNull();
  });
});

describe("artifactSourceChip", () => {
  it("translates known source enums to short chips", () => {
    expect(
      artifactSourceChip(makeArtifact({ source: "user_upload" })),
    ).toBe("Uploaded");
    expect(
      artifactSourceChip(makeArtifact({ source: "request_upload" })),
    ).toBe("From request");
    expect(
      artifactSourceChip(makeArtifact({ source: "template_generation" })),
    ).toBe("From template");
    expect(
      artifactSourceChip(makeArtifact({ source: "docuseal" })),
    ).toBe("From DocuSeal");
  });

  it("returns null for unknown source values", () => {
    expect(
      artifactSourceChip(makeArtifact({ source: "weird_internal" })),
    ).toBeNull();
    expect(artifactSourceChip(makeArtifact({ source: null }))).toBeNull();
  });
});
