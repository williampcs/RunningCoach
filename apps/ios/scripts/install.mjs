// 建置並裝到接在這台 Mac 上的 iPhone（規格 12.49）。先跑過 npm run sync 與 setup-signing。
// 用法：npm run install-device -w @running-coach/ios
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const derived = join(here, "ios", "DerivedData");
const run = (cmd) => execSync(cmd, { cwd: here, stdio: "inherit" });

const listFile = join(tmpdir(), `devicectl-${process.pid}.json`);
execSync(`xcrun devicectl list devices --json-output ${listFile}`, { stdio: "ignore" });
const devices = JSON.parse(readFileSync(listFile, "utf8")).result?.devices ?? [];
rmSync(listFile, { force: true });
const phone = devices.find((d) => d.hardwareProperties?.platform === "iOS" && d.connectionProperties?.tunnelState !== "unavailable");
if (!phone) {
  console.error("找不到接上的 iPhone：用線接上、解鎖、選「信任這部電腦」，並打開開發者模式。");
  process.exit(1);
}

run(
  `xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -destination "id=${phone.hardwareProperties.udid}" -derivedDataPath "${derived}" -allowProvisioningUpdates -quiet build`,
);
run(`xcrun devicectl device install app --device ${phone.identifier} "${join(derived, "Build", "Products", "Debug-iphoneos", "App.app")}"`);
console.log("已裝到 iPhone。第一次要在 iPhone 的 設定 → 一般 → VPN 與裝置管理 信任開發者。");
