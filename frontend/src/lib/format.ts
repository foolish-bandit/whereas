const KNOWN_MIME_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "DOCX",
};

const KNOWN_MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
};

export function mimeLabel(mime: string): string {
  return KNOWN_MIME_LABELS[mime] ?? mime;
}

export function mimeExtension(mime: string): string {
  return KNOWN_MIME_EXTENSIONS[mime] ?? "";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })} ${d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  } catch {
    return iso;
  }
}

/** Lower_snake_case → Title Case, with a few legal-domain overrides. */
const FIELD_NAME_OVERRIDES: Record<string, string> = {
  parties: "Parties",
  effective_date: "Effective date",
  expiration_date: "Expiration date",
  term_months: "Term (months)",
  governing_law: "Governing law",
  contract_value: "Contract value",
  renewal_terms: "Renewal terms",
  termination_provisions: "Termination provisions",
  jurisdiction: "Jurisdiction",
};

export function humanizeFieldName(field: string): string {
  if (FIELD_NAME_OVERRIDES[field]) return FIELD_NAME_OVERRIDES[field];
  if (!field) return field;
  const parts = field.replace(/[_-]+/g, " ").trim().split(/\s+/);
  if (parts.length === 0) return field;
  return parts
    .map((p, i) =>
      i === 0
        ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
        : p.toLowerCase(),
    )
    .join(" ");
}

const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]+/g;

export function sanitizeFilename(name: string, fallbackExt = ""): string {
  const base = (name || "").trim().replace(UNSAFE_FILENAME_CHARS, "_");
  const cleaned = base.replace(/^[._]+|[._]+$/g, "") || "contract";
  if (fallbackExt && !cleaned.toLowerCase().endsWith(fallbackExt.toLowerCase())) {
    return `${cleaned}${fallbackExt}`.slice(0, 180);
  }
  return cleaned.slice(0, 180);
}

/**
 * Render an extracted value (which the backend stores loosely as JSON) as a
 * legible string. Falls back to JSON for structured types we don't have a
 * domain-specific renderer for. Never throws.
 */
export function renderExtractedValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : renderExtractedValue(v)))
      .filter((v) => v && v !== "—")
      .join(", ");
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("amount" in v && "currency" in v) {
      const amount = v.amount;
      const currency = v.currency;
      if (
        (typeof amount === "number" || typeof amount === "string") &&
        typeof currency === "string"
      ) {
        return `${amount} ${currency}`;
      }
    }
    if ("name" in v && typeof v.name === "string") {
      return v.name;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "—";
    }
  }
  return "—";
}

/**
 * Days between today (midnight UTC) and an ISO date (date-only or
 * date-time). Positive when the target is in the future. Returns null
 * for invalid inputs so callers can render an em-dash.
 */
export function daysUntil(iso: string, now: Date = new Date()): number | null {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;
  const MS_PER_DAY = 86_400_000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const then = Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
  );
  return Math.round((then - today) / MS_PER_DAY);
}

/**
 * Friendly relative phrase for a date that's within `windowDays` of
 * today. Returns null when the date is further out — callers should
 * fall back to the absolute formatted date in that case.
 */
export function relativeDateWithin(
  iso: string,
  windowDays: number,
  now: Date = new Date(),
): string | null {
  const delta = daysUntil(iso, now);
  if (delta === null) return null;
  if (Math.abs(delta) > windowDays) return null;
  if (delta === 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta === -1) return "yesterday";
  if (delta > 1) return `in ${delta} days`;
  return `${Math.abs(delta)} days ago`;
}

export function confidenceTier(
  confidence: number,
): "high" | "medium" | "low" {
  if (!Number.isFinite(confidence)) return "low";
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}
