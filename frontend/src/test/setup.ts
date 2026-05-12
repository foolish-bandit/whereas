import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement ResizeObserver; cmdk (and similar UI libs)
// instantiate one on mount.
if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  class ResizeObserverShim {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: typeof ResizeObserverShim }).ResizeObserver =
    ResizeObserverShim;
}

// jsdom Element doesn't implement scrollIntoView; cmdk + several
// existing components call it on selection changes.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
