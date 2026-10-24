import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { currentVersion, nextVersion, setVersion, workspaceDirs } from "../version-bump";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

describe("nextVersion", () => {
  it("有新功能加中間那碼、只修錯誤加最後一碼", () => {
    expect(nextVersion("0.1.0", "minor")).toBe("0.2.0");
    expect(nextVersion("0.2.0", "patch")).toBe("0.2.1");
    expect(nextVersion("0.2.1", "minor")).toBe("0.3.0");
    expect(nextVersion("0.9.3", "major")).toBe("1.0.0");
    expect(nextVersion("0.2.1", "0.5.0")).toBe("0.5.0");
  });

  it("不認得的參數或版號報錯", () => {
    expect(() => nextVersion("0.1.0", "feature")).toThrow();
    expect(() => nextVersion("0.1", "patch")).toThrow();
  });
});

describe("setVersion", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("根目錄、各套件與 lockfile 一次改好，其他欄位不動", () => {
    dir = mkdtempSync(join(tmpdir(), "version-bump-"));
    const write = (path: string, data: unknown) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), `${JSON.stringify(data, null, 2)}\n`);
    };
    write("package.json", { name: "root", version: "0.1.0", private: true, workspaces: ["apps/*"] });
    write("apps/a/package.json", { name: "@x/a", version: "0.1.0", private: true });
    write("apps/b/package.json", { name: "@x/b", version: "0.1.0", type: "module" });
    write("package-lock.json", {
      name: "root",
      version: "0.1.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "root", version: "0.1.0" },
        "apps/a": { name: "@x/a", version: "0.1.0" },
        "apps/b": { name: "@x/b", version: "0.1.0" },
        "node_modules/dep": { version: "0.1.0", resolved: "x" },
      },
    });

    expect(setVersion(dir, nextVersion(currentVersion(dir), "minor"))).toEqual([
      "package.json",
      "apps/a/package.json",
      "apps/b/package.json",
      "package-lock.json",
    ]);
    expect(read(join(dir, "package.json"))).toEqual({ name: "root", version: "0.2.0", private: true, workspaces: ["apps/*"] });
    expect(read(join(dir, "apps/b/package.json"))).toEqual({ name: "@x/b", version: "0.2.0", type: "module" });
    const lock = read(join(dir, "package-lock.json"));
    expect(lock.version).toBe("0.2.0");
    expect(lock.packages[""].version).toBe("0.2.0");
    expect(lock.packages["apps/a"].version).toBe("0.2.0");
    // 相依套件剛好同版號也不能動
    expect(lock.packages["node_modules/dep"].version).toBe("0.1.0");
    // 已經是這個版號時什麼都不改
    expect(setVersion(dir, "0.2.0")).toEqual([]);
  });
});

describe("repo 的版號", () => {
  it("各套件與 lockfile 都和根目錄的 package.json 一致", () => {
    const version = currentVersion(REPO);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = read(join(REPO, "package-lock.json"));
    expect(lock.version).toBe(version);
    for (const ws of ["", ...workspaceDirs(REPO)]) {
      expect(read(join(REPO, ws, "package.json")).version, ws || "root").toBe(version);
      expect(lock.packages[ws]?.version, `lock ${ws}`).toBe(version);
    }
  });
});
