import { describe, expect, it } from "vitest";

import { canonicalOrigin, movedTo } from "../src/environment";

describe("canonicalOrigin", () => {
  it("keeps only the origin", () => {
    expect(canonicalOrigin("https://app.zone2mate.com/")).toBe("https://app.zone2mate.com");
    expect(canonicalOrigin(" https://app.zone2mate.com/some/path ")).toBe("https://app.zone2mate.com");
  });

  it("is null when unset or not a web address", () => {
    expect(canonicalOrigin(undefined)).toBeNull();
    expect(canonicalOrigin("")).toBeNull();
    expect(canonicalOrigin("app.zone2mate.com")).toBeNull();
    expect(canonicalOrigin("ftp://app.zone2mate.com")).toBeNull();
  });
});

describe("movedTo", () => {
  const web = "https://app.zone2mate.com";

  it("points the old address to the canonical one", () => {
    expect(movedTo("https://running-coach-bgb.pages.dev", web, false)).toBe(web);
  });

  it("is null on the canonical address", () => {
    expect(movedTo(web, `${web}/`, false)).toBeNull();
  });

  it("is null without a canonical address (local development, tests)", () => {
    expect(movedTo("http://localhost:4173", undefined, false)).toBeNull();
    expect(movedTo("http://localhost:4173", "", false)).toBeNull();
  });

  it("is never shown on staging", () => {
    expect(movedTo("https://running-coach-staging.pages.dev", "https://staging.zone2mate.com", true)).toBeNull();
  });
});
