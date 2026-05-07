const STORAGE_KEY = "whereas.devUserId";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export function getDevUserId(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value && isValidUuid(value)) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export function setDevUserId(value: string): void {
  const trimmed = value.trim();
  if (!isValidUuid(trimmed)) {
    throw new Error("Dev user ID must be a UUID.");
  }
  window.localStorage.setItem(STORAGE_KEY, trimmed);
}

export function clearDevUserId(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
