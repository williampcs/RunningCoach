import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appGuide, findGuide } from "../src";
import { makeCoach, toolTurn, turn } from "./helpers";

/** 一個資料夾底下所有 .ts／.tsx 的內容 */
function sourceText(dir: string, skip?: string): string {
  return readdirSync(dir)
    .filter((name) => name !== skip)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? sourceText(path, skip) : /\.tsx?$/.test(path) ? readFileSync(path, "utf8") : ""))
    .join("\n");
}

const root = join(__dirname, "../../..");

describe("功能說明", () => {
  it("每一段都有代號、標題與內容，代號不重複", () => {
    for (const shell of ["web", "discord"] as const) {
      const ids = appGuide(shell).map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of appGuide(shell)) {
        expect(s.id).toMatch(/^[a-z0-9-]+$/);
        expect(s.title && s.body.trim()).toBeTruthy();
      }
    }
  });

  it("網頁版：說明裡「」括起來的名稱，網頁版的程式裡都有（改了按鈕名稱要一起改說明）", () => {
    // 教練動態的按鈕名稱在 core（feed.ts 等）；說明本身不算
    const source = sourceText(join(root, "apps/web/src")) + sourceText(join(root, "packages/core/src"), "app-guide");
    const missing = appGuide("web").flatMap((s) =>
      [...s.body.matchAll(/「([^」]+)」/g)].map((m) => m[1]!).filter((label) => !source.includes(label)).map((label) => `${s.id}：「${label}」`),
    );
    expect(missing).toEqual([]);
  });

  it("Discord：說明裡的指令都存在", () => {
    const source = readFileSync(join(root, "apps/discord/src/bot.ts"), "utf8");
    const commands = appGuide("discord").flatMap((s) => [...s.body.matchAll(/`\/([a-z]+)`/g)].map((m) => m[1]!));
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(source).toContain(`setName("${c}")`);
  });

  it("依代號、標題、其他說法找", () => {
    expect(findGuide("web", "device-sync").map((s) => s.id)).toEqual(["device-sync"]);
    expect(findGuide("web", "密碼鎖")[0]?.id).toBe("key-lock");
    expect(findGuide("web", "QR code")[0]?.id).toBe("device-sync");
    expect(findGuide("web", "完全無關的字")).toEqual([]);
  });

  it("教練用 get_app_help 查，網頁版附上說明頁的連結；系統提示列出主題，跑後回報的同步依網頁版或 Discord 說", async () => {
    const { coach, provider } = await makeCoach([toolTurn("get_app_help", { topic: "密碼鎖" }), turn({ text: "設定頁…" })], {
      settings: { shell: "web" },
    });
    await coach.chat("密碼鎖怎麼用？");
    const system = provider.calls[0]!.request.system;
    expect(system).toContain("key-lock（密碼鎖）");
    expect(system).toContain("到「回報」按「同步最近 14 天」");
    expect(system).not.toContain("/sync");
    const result = provider.calls[1]!.toolResults![0]!.content;
    expect(result).toContain("## 密碼鎖");
    expect(result).toContain("[看完整說明](#help/key-lock)");

    const bot = await makeCoach([turn({ text: "好" })]);
    await bot.coach.chat("嗨");
    expect(bot.provider.calls[0]!.request.system).toContain("輸入 /sync");
    expect(bot.provider.calls[0]!.request.system).toContain("commands（指令）");
  });
});
