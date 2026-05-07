import { formatBytes } from "./format";

export const ACCEPTED_EXTENSIONS = [".pdf", ".docx"] as const;
export const ACCEPTED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0) return "";
  return name.slice(idx).toLowerCase();
}

export function validateFile(file: File): string | null {
  const ext = extOf(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(ext as (typeof ACCEPTED_EXTENSIONS)[number])) {
    return `Unsupported file type "${ext || "(none)"}". Whereas accepts PDF or DOCX.`;
  }
  if (file.size === 0) {
    return "The selected file is empty.";
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    return `File is ${formatBytes(file.size)} (max ${formatBytes(UPLOAD_MAX_BYTES)}).`;
  }
  return null;
}
