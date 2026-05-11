import { describe, expect, it } from "vitest";

import {
  artifactDisplayLabel,
  artifactOriginCopy,
  artifactSourceChip,
  formatFileSize,
  getArtifactHistoryItems,
  isCurrentArtifact,
  pickCurrentDocumentLabel,
  pickPrimaryOriginCopy,
  safeArtifactMetadataChips,
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

describe("safeArtifactMetadataChips", () => {
  it("renders a Template chip from generated_docx metadata_json", () => {
    const a = makeArtifact({
      artifact_type: "generated_docx",
      source: "template_generation",
      metadata_json: {
        template_id: "tpl-1",
        template_name: "Mutual NDA",
        variable_keys: ["counterparty", "term_months"],
        variable_keys_blank: [],
        generated_at: "2026-05-01T00:00:00Z",
      },
    });
    const chips = safeArtifactMetadataChips(a);
    expect(chips).toEqual([{ key: "template_name", label: "Template: Mutual NDA" }]);
  });

  it("renders a 'From request' chip when a request_upload artifact has a request_id", () => {
    const a = makeArtifact({
      artifact_type: "original_upload",
      source: "request_upload",
      metadata_json: {
        request_id: "req-1",
        upload_source: "request_conversion",
        notes: "user-supplied free text that must never render",
      },
    });
    const chips = safeArtifactMetadataChips(a);
    expect(chips.map((c) => c.key)).toEqual(["request_id"]);
    expect(chips[0].label).toBe("From request");
  });

  it("never returns chip labels containing free-text notes / variable_keys / raw ids", () => {
    const a = makeArtifact({
      artifact_type: "generated_docx",
      source: "template_generation",
      metadata_json: {
        template_id: "tpl-secret-id",
        template_name: "Mutual NDA",
        variable_keys: ["counterparty_name", "dollar_amount"],
        notes: "internal commentary",
      },
    });
    const labels = safeArtifactMetadataChips(a).map((c) => c.label);
    expect(labels.join("|")).not.toContain("tpl-secret-id");
    expect(labels.join("|")).not.toContain("counterparty_name");
    expect(labels.join("|")).not.toContain("dollar_amount");
    expect(labels.join("|")).not.toContain("internal commentary");
  });

  it("renders a 'DocuSeal submission' chip without leaking the raw submission id", () => {
    const a = makeArtifact({
      artifact_type: "signed_pdf",
      source: "docuseal",
      metadata_json: {
        docuseal_submission_id: "sub-VERY-LONG-OPAQUE-ID-9999",
        signed_at: "2026-05-02T12:00:00Z",
        docuseal_event_id: "evt-internal",
      },
    });
    const chips = safeArtifactMetadataChips(a);
    const labels = chips.map((c) => c.label).join("|");
    expect(labels).toContain("Signed 2026-05-02T12:00:00Z");
    expect(labels).toContain("DocuSeal submission");
    // The raw submission id and event id never reach the rendered label.
    expect(labels).not.toContain("sub-VERY-LONG-OPAQUE-ID-9999");
    expect(labels).not.toContain("evt-internal");
  });

  it("ignores keys outside the allowlist", () => {
    const a = makeArtifact({
      artifact_type: "original_upload",
      source: "user_upload",
      metadata_json: {
        storage_key: "s3://leak/me",
        wrapped_dek: "00".repeat(32),
        notes: "user-provided notes",
        title: "Internal title",
      },
    });
    expect(safeArtifactMetadataChips(a)).toEqual([]);
  });
});

describe("isCurrentArtifact", () => {
  const signed = makeArtifact({ id: "art-signed", artifact_type: "signed_pdf" });
  const generated = makeArtifact({ id: "art-gen", artifact_type: "generated_docx" });
  const original = makeArtifact({ id: "art-orig", artifact_type: "original_upload" });

  it("marks signed_pdf current when all three are present", () => {
    const list = [signed, generated, original];
    expect(isCurrentArtifact(signed, list)).toBe(true);
    expect(isCurrentArtifact(generated, list)).toBe(false);
    expect(isCurrentArtifact(original, list)).toBe(false);
  });

  it("marks generated_docx current when only generated + original exist", () => {
    const list = [generated, original];
    expect(isCurrentArtifact(generated, list)).toBe(true);
    expect(isCurrentArtifact(original, list)).toBe(false);
  });

  it("marks original_upload current when it's the only artifact", () => {
    const list = [original];
    expect(isCurrentArtifact(original, list)).toBe(true);
  });
});

describe("getArtifactHistoryItems", () => {
  const signed = makeArtifact({
    id: "art-signed",
    artifact_type: "signed_pdf",
    source: "docuseal",
    created_at: "2026-05-03T00:00:00Z",
    filename: "executed.pdf",
    mime_type: "application/pdf",
    metadata_json: {
      docuseal_submission_id: "sub-1",
      signed_at: "2026-05-03T00:00:00Z",
    },
  });
  const generated = makeArtifact({
    id: "art-gen",
    artifact_type: "generated_docx",
    source: "template_generation",
    created_at: "2026-05-02T00:00:00Z",
    filename: "draft.docx",
    mime_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    metadata_json: { template_id: "tpl-1", template_name: "Mutual NDA" },
  });
  const original = makeArtifact({
    id: "art-orig",
    artifact_type: "original_upload",
    source: "user_upload",
    created_at: "2026-05-01T00:00:00Z",
    filename: "source.pdf",
    mime_type: "application/pdf",
  });

  it("returns rows newest first by created_at", () => {
    const items = getArtifactHistoryItems([original, signed, generated]);
    expect(items.map((i) => i.artifact.id)).toEqual([
      "art-signed",
      "art-gen",
      "art-orig",
    ]);
  });

  it("flags exactly one row as current, picking the priority winner", () => {
    const items = getArtifactHistoryItems([signed, generated, original]);
    const current = items.filter((i) => i.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0].artifact.id).toBe("art-signed");
  });

  it("flags generated_docx as current when no signed PDF exists", () => {
    const items = getArtifactHistoryItems([generated, original]);
    const current = items.filter((i) => i.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0].artifact.id).toBe("art-gen");
  });

  it("flags original_upload as current when it's the only artifact", () => {
    const items = getArtifactHistoryItems([original]);
    expect(items[0].isCurrent).toBe(true);
  });

  it("returns an empty list for a contract with no artifacts", () => {
    expect(getArtifactHistoryItems([])).toEqual([]);
  });

  it("attaches user-friendly labels (never the raw artifact_type enum)", () => {
    const items = getArtifactHistoryItems([signed, generated, original]);
    expect(items[0].displayLabel).toBe("Signed PDF");
    expect(items[1].displayLabel).toBe("Generated Word document");
    expect(items[2].displayLabel).toBe("Source file");
    for (const item of items) {
      expect(item.displayLabel).not.toMatch(/original_upload/);
      expect(item.displayLabel).not.toMatch(/generated_docx/);
      expect(item.displayLabel).not.toMatch(/signed_pdf/);
    }
  });

  it("never surfaces storage_key / wrapped_dek values via the metadata chips", () => {
    // The helper passes ``artifact`` through unmodified for the
    // renderer; the safety contract is that ``metadataChips`` only
    // carries allowlisted keys+labels. The renderer itself never
    // reads ``artifact.metadata_json`` for display.
    const naughty = makeArtifact({
      artifact_type: "original_upload",
      source: "user_upload",
      metadata_json: {
        storage_key: "s3://internal/whoops",
        wrapped_dek: "00".repeat(32),
        notes: "internal",
      },
    });
    const items = getArtifactHistoryItems([naughty]);
    expect(items[0].metadataChips).toEqual([]);
    const chipBlob = JSON.stringify(items[0].metadataChips);
    expect(chipBlob).not.toContain("storage_key");
    expect(chipBlob).not.toContain("wrapped_dek");
    expect(chipBlob).not.toContain("s3://internal");
    expect(chipBlob).not.toContain("internal");
  });
});

describe("formatFileSize", () => {
  it("re-exports the shared formatBytes helper", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
  });
});
