import { describe, expect, it } from "vitest";

import { TERMS_SHORT } from "@running-coach/core";

import { pageForApp } from "../privacy/in-app";
import { renderPrivacyPage } from "../privacy/render";
import { renderTermsPage } from "../terms/render";

const terms = renderTermsPage({ staging: false });
const privacy = renderPrivacyPage({ staging: false, syncUrl: "https://sync.example.com" });

describe("App 裡的使用須知與隱私說明（KI-046）", () => {
  it("和靜態頁同一份內容：每一節都在，拿掉「回到 Zone2Mate」與大標題", () => {
    for (const [html, prefix] of [
      [terms, "terms"],
      [privacy, "privacy"],
    ] as const) {
      const inApp = pageForApp(html, prefix);
      const sections = (s: string) => [...s.matchAll(/<section[ >]/g)].length;
      expect(sections(inApp)).toBe(sections(html));
      expect(inApp).not.toContain("回到 Zone2Mate");
      expect(inApp).not.toMatch(/<h1/);
      expect(inApp).not.toMatch(/<script|<!doctype|<body/i);
    }
    const inApp = pageForApp(terms, "terms");
    expect(inApp).toContain(TERMS_SHORT);
    expect([...inApp.matchAll(/<h2 id="terms-[a-z-]+">(\d+)\. /g)]).toHaveLength(16);
  });

  it("id 加上前綴、aria-labelledby 跟著改；外部網址在新分頁打開，兩頁之間的連結不變（App 攔下來換面板）", () => {
    const inApp = pageForApp(privacy, "privacy");
    expect(inApp).not.toMatch(/ id="(?!privacy-)/);
    for (const [, label] of inApp.matchAll(/aria-labelledby="([^"]+)"/g)) expect(inApp).toContain(`id="${label}"`);
    expect(inApp).not.toMatch(/<a href="(https?:|mailto:)/);
    expect(inApp).toContain('<a target="_blank" rel="noreferrer" href="mailto:privacy@zone2mate.com"');
    expect(inApp).toContain('<a href="/terms">');
    expect(inApp).toContain("sync.example.com");
  });
});
