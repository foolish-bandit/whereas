import { afterEach, describe, expect, it } from "vitest";

import {
  clearDevUserId,
  getDevUserId,
  isValidUuid,
  setDevUserId,
} from "../devUser";

describe("devUser", () => {
  afterEach(() => {
    clearDevUserId();
  });

  it("validates UUIDs", () => {
    expect(isValidUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid("")).toBe(false);
  });

  it("round-trips a valid UUID through localStorage", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    setDevUserId(id);
    expect(getDevUserId()).toBe(id);
  });

  it("rejects invalid UUIDs on save", () => {
    expect(() => setDevUserId("nope")).toThrow();
  });

  it("clears the stored value", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    setDevUserId(id);
    clearDevUserId();
    expect(getDevUserId()).toBeNull();
  });
});
