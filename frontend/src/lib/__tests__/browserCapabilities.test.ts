import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeCapability,
  detectBrowserCapabilities,
} from "../browserCapabilities";

describe("detectBrowserCapabilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns all-false outside a browser environment", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);

    const caps = detectBrowserCapabilities();
    expect(caps).toEqual({
      serviceWorker: false,
      storagePersistence: false,
      fileSystemAccess: false,
      opfs: false,
    });
  });

  it("detects each capability independently", () => {
    // jsdom does not expose serviceWorker / storage.persist /
    // showOpenFilePicker by default, so we synthesize them here. We
    // patch on top of the real navigator/window so other globals stay
    // intact for the rest of the file.
    const fakeStorage = {
      persist: () => Promise.resolve(true),
      getDirectory: () => Promise.resolve({}),
    };
    const fakeNavigator = {
      serviceWorker: {},
      storage: fakeStorage,
    };
    vi.stubGlobal("navigator", fakeNavigator);

    const fakeWindow = {
      showOpenFilePicker: () => Promise.resolve([]),
    };
    vi.stubGlobal("window", fakeWindow);

    const caps = detectBrowserCapabilities();
    expect(caps.serviceWorker).toBe(true);
    expect(caps.storagePersistence).toBe(true);
    expect(caps.fileSystemAccess).toBe(true);
    expect(caps.opfs).toBe(true);
  });

  it("does not call permission-prompting APIs", () => {
    const persist = vi.fn();
    const getDirectory = vi.fn();
    const showOpenFilePicker = vi.fn();
    vi.stubGlobal("navigator", {
      serviceWorker: {},
      storage: { persist, getDirectory },
    });
    vi.stubGlobal("window", { showOpenFilePicker });

    detectBrowserCapabilities();

    expect(persist).not.toHaveBeenCalled();
    expect(getDirectory).not.toHaveBeenCalled();
    expect(showOpenFilePicker).not.toHaveBeenCalled();
  });

  it("reports unavailable capabilities as false", () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", {});
    const caps = detectBrowserCapabilities();
    expect(caps).toEqual({
      serviceWorker: false,
      storagePersistence: false,
      fileSystemAccess: false,
      opfs: false,
    });
  });
});

describe("describeCapability", () => {
  it("returns a label and description for every key", () => {
    const keys = [
      "serviceWorker",
      "storagePersistence",
      "fileSystemAccess",
      "opfs",
    ] as const;
    for (const key of keys) {
      const { label, description } = describeCapability(key);
      expect(label.length).toBeGreaterThan(0);
      expect(description.length).toBeGreaterThan(0);
    }
  });
});
