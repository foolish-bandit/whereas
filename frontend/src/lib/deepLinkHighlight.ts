/**
 * Shared CSS class string applied to a row that matches a deep-link
 * target (`?request_id=`, `?workflow_id=`, `?policy_id=`). Subtle
 * persistent highlight — info-soft background plus the info-ring
 * border — so the row reads as the obvious destination without
 * needing animation or a timeout.
 */
export const DEEP_LINK_HIGHLIGHT_CLASS =
  "border-info-ring bg-info-soft ring-1 ring-info-ring";

/**
 * Scrolls the given element into view (if the platform supports it).
 * No-op in JSDOM and headless environments where ``scrollIntoView``
 * isn't defined.
 */
export function scrollDeepLinkIntoView(el: Element | null): void {
  if (!el) return;
  if (typeof (el as HTMLElement).scrollIntoView === "function") {
    (el as HTMLElement).scrollIntoView({ block: "center" });
  }
}
