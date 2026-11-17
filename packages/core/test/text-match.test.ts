import { describe, expect, it } from "vitest";

import { typeOfText } from "../src/activity-files/gpx";
import { normalizeProxyUrl } from "../src/device-sync/trial-account";
import { parsePace } from "../src/fake-activities";
import { splitSummary, SUMMARY_LABEL } from "../src/history";
import { classifyKeyError } from "../src/llm/check";
import { headingTitle, splitReplySections } from "../src/reply-sections";
import { appearsAfter, trimTrailingSlashes } from "../src/text-match";
import { matchTaiwanCities, openMeteoUrlsAt, stripEnglishSuffix } from "../src/weather";

// 改寫前的正規表示式，拿來比對行為不變（規格 12.45 第 8 點）
const OLD = {
  slashes: (s: string) => s.replace(/\/+$/, ""),
  heading: (s: string) => /^ {0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(s)?.[1]!.trim() ?? null,
  label: /^\s*(?:[*_#>]|\p{Extended_Pictographic}|\s)*(?:AI\s*評估|教練評估|評估|分析)\s*[*_]*\s*[:：]\s*[*_]*\s*/u,
  pace: (s: string) => {
    const m = /^\s*(\d{1,2}):([0-5]\d)\s*(\/km)?\s*$/.exec(s);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  },
  englishSuffix: (s: string) => s.replace(/\s+(city|county)$/, ""),
};

/** 固定種子的亂數，用小字母表產生各種組合 */
function randomStrings(alphabet: string[], count: number, maxLength: number, seed = 1): string[] {
  let x = seed;
  const next = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x);
  return Array.from({ length: count }, () => {
    const n = next() % (maxLength + 1);
    return Array.from({ length: n }, () => alphabet[next() % alphabet.length]).join("");
  });
}

/** 很長的特殊輸入要在很短的時間內跑完（改寫前要好幾秒以上） */
function fast(fn: () => unknown) {
  const start = performance.now();
  fn();
  expect(performance.now() - start).toBeLessThan(500);
}

const N = 50_000;

describe("正規表示式改成線性時間：行為不變", () => {
  it("去掉結尾的斜線", () => {
    for (const s of ["", "/", "///", "https://a.b", "https://a.b/", "https://a.b///", "a/b/", "/a", "a//b//"]) {
      expect(trimTrailingSlashes(s)).toBe(OLD.slashes(s));
    }
    for (const s of randomStrings(["/", "a", " "], 2000, 8)) expect(trimTrailingSlashes(s)).toBe(OLD.slashes(s));
    expect(openMeteoUrlsAt("http://localhost:1/").forecast).toBe("http://localhost:1/v1/forecast");
    expect(normalizeProxyUrl(" https://p.example/// ")).toBe("https://p.example");
  });

  it("同一行裡某個字之後出現另一段文字", () => {
    const old = (s: string) => /virtual.*(ride|cycl)/.test(s);
    for (const s of randomStrings(["virtual", "ride", "cycl", "x", "\n", "\r", " "], 3000, 6)) {
      expect(appearsAfter(s, "virtual", /ride|cycl/)).toBe(old(s));
    }
    expect(typeOfText("VirtualRide")).toBe("VirtualRide");
    expect(typeOfText("virtual_cycling")).toBe("VirtualRide");
    expect(typeOfText("ride")).toBe("Ride");
    expect(typeOfText("virtual\nride")).toBe("Ride");
    const oldModel = (s: string) => /model.*(not found|does not exist)|not_found_error/.test(s);
    for (const s of randomStrings(["model", "not found", "does not exist", "not_found_error", "x", "\n"], 3000, 5, 7)) {
      expect(classifyKeyError(new Error(s)) === "model").toBe(oldModel(s.toLowerCase()));
    }
  });

  it("回覆的小標", () => {
    const samples = ["## 標題", "##標題", "   ## 標題 ##", "    ## 標題", "## #", "## ", "##  ", "## a#", "## a #", "## a # #", "##\ta\t#\t", "## a\r", "### a", "## ##", "## # #"];
    for (const s of samples) expect(headingTitle(s)).toBe(OLD.heading(s));
    for (const s of randomStrings([" ", "\t", "#", "a", "\r"], 20000, 9, 3)) {
      const line = `##${s}`;
      expect(headingTitle(line)).toBe(OLD.heading(line));
      expect(headingTitle(` ${line}`)).toBe(OLD.heading(` ${line}`));
    }
  });

  it("摘要的標籤", () => {
    const samples = ["AI評估：跑得不錯", "**教練評估**：好", "> 📝 評估 ** ： ** 好", "評估 * : _ x", "分析", "評估 * * : x", "  ## 分析:   結論", "評估x：", "AI  評估：a"];
    for (const s of samples) expect(s.replace(SUMMARY_LABEL, "")).toBe(s.replace(OLD.label, ""));
    for (const s of randomStrings(["評估", "AI", " ", "*", "_", "：", ":", "#", "x"], 20000, 7, 5)) {
      expect(s.replace(SUMMARY_LABEL, "")).toBe(s.replace(OLD.label, ""));
    }
    expect(splitSummary("**AI評估**：今天的節奏很穩。\n\n細節").headline).toBe("今天的節奏很穩。");
  });

  it("配速", () => {
    const samples = ["5:45", " 5:45 ", "5:45/km", "5:45 /km ", "5:45/ km", "12:00", "5:60", "123:00", "5:45km", "\t5:45\n"];
    for (const s of samples) expect(parsePace(s)).toBe(OLD.pace(s));
    for (const s of randomStrings(["5", ":", "45", " ", "/km", "\n", "x"], 5000, 6, 9)) expect(parsePace(s)).toBe(OLD.pace(s));
  });

  it("台灣縣市的英文名稱", () => {
    expect(matchTaiwanCities("Taipei City").map((c) => c.label)).toEqual(matchTaiwanCities("taipei").map((c) => c.label));
    expect(matchTaiwanCities("Hualien County").length).toBeGreaterThan(0);
    for (const s of randomStrings(["city", "county", " ", "\t", "a"], 5000, 5, 11)) expect(stripEnglishSuffix(s)).toBe(OLD.englishSuffix(s));
  });
});

describe("正規表示式改成線性時間：很長的特殊輸入", () => {
  it("很快跑完", () => {
    fast(() => trimTrailingSlashes(`${"/".repeat(N)}a`));
    fast(() => openMeteoUrlsAt(`x${"/".repeat(N)}x`));
    fast(() => normalizeProxyUrl(`x${"/".repeat(N)}x`));
    fast(() => typeOfText("virtual".repeat(N / 5)));
    fast(() => classifyKeyError(new Error("model ".repeat(N / 5))));
    fast(() => splitReplySections(`## a${" ".repeat(N)}a\r`));
    fast(() => splitReplySections(`## a${"#".repeat(N)}\r`));
    fast(() => splitReplySections(`## ${" \t#".repeat(N / 3)}x\r`));
    fast(() => splitSummary(`評估${" ".repeat(N)}x`));
    fast(() => splitSummary(`${" ".repeat(N)}x`));
    fast(() => splitSummary(`評估${" *".repeat(N / 2)}x`));
    fast(() => parsePace(`5:45${" ".repeat(N)}x`));
    fast(() => matchTaiwanCities(`a${" ".repeat(N)}x`));
    fast(() => stripEnglishSuffix(`a${" ".repeat(N)}x`));
  });
});
