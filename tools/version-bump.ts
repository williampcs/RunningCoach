/**
 * 改版號（規格 12.19）：版號只有一個來源，repo 根目錄的 package.json；網頁版與 Discord bot 都讀它.
 * 各套件的 package.json 與 package-lock.json 一起改成同一個版號，避免看到不一致的數字.
 *
 *   npm run version:bump -- minor   # 有新功能：0.1.0 → 0.2.0
 *   npm run version:bump -- patch   # 只修錯誤：0.2.0 → 0.2.1
 *   npm run version:bump -- major   # 正式版：0.9.3 → 1.0.0
 *   npm run version:bump -- 0.3.0   # 直接指定
 *
 * 只改檔案，不 commit、不打標籤（發版步驟見 CLAUDE.md 的「合併部署」）.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type BumpKind = "major" | "minor" | "patch";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** 算出下一個版號；kind 也可以直接是 X.Y.Z */
export function nextVersion(current: string, kind: string): string {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`目前的版號不是 X.Y.Z：${current}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (SEMVER.test(kind)) return kind;
  throw new Error(`要 major、minor、patch 或 X.Y.Z，收到：${kind}`);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** 設定 version，放在 name 後面（和 npm 的寫法一樣），其他欄位的順序不變 */
function withVersion(obj: Record<string, unknown>, version: string): Record<string, unknown> {
  const { name, version: _old, ...rest } = obj;
  return name === undefined ? { version, ...rest } : { name, version, ...rest };
}

/** workspaces 列的資料夾（只支援「資料夾/*」的寫法），回傳相對於 root 的路徑 */
export function workspaceDirs(root: string): string[] {
  const workspaces = (readJson(join(root, "package.json")).workspaces ?? []) as string[];
  return workspaces.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, parent, d.name, "package.json")))
      .map((d) => `${parent}/${d.name}`)
      .sort();
  });
}

/** 把根目錄、各套件與 lockfile 的版號都設成 version；回傳改過的檔案 */
export function setVersion(root: string, version: string): string[] {
  if (!SEMVER.test(version)) throw new Error(`版號要是 X.Y.Z：${version}`);
  const changed: string[] = [];
  const dirs = workspaceDirs(root);

  for (const dir of ["", ...dirs]) {
    const file = join(dir, "package.json");
    const pkg = readJson(join(root, file));
    if (pkg.version === version) continue;
    writeJson(join(root, file), withVersion(pkg, version));
    changed.push(file);
  }

  const lockPath = join(root, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = readJson(lockPath);
    const packages = (lock.packages ?? {}) as Record<string, Record<string, unknown>>;
    let dirty = false;
    for (const key of ["", ...dirs]) {
      const entry = packages[key];
      if (!entry || entry.version === version) continue;
      packages[key] = withVersion(entry, version);
      dirty = true;
    }
    if (lock.version !== version) dirty = true;
    if (dirty) {
      // 最上層的 version 也放在 name 後面（npm install 會這樣寫）
      writeJson(lockPath, withVersion(lock, version));
      changed.push("package-lock.json");
    }
  }
  return changed;
}

/** 根目錄 package.json 的版號 */
export function currentVersion(root: string): string {
  return String(readJson(join(root, "package.json")).version);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const kind = process.argv[2];
  if (!kind) {
    console.error("用法：npm run version:bump -- major|minor|patch|X.Y.Z");
    process.exit(1);
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const from = currentVersion(root);
  const to = nextVersion(from, kind);
  const changed = setVersion(root, to);
  console.log(`版號 ${from} → ${to}`);
  for (const file of changed) console.log(`  改了 ${file}`);
}
