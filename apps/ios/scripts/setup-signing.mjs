// 在你的 Mac 上寫 ios/signing.local.xcconfig（不進版控；規格 12.49）。
// 1. 先跑一次：寫一個這台專用的 bundle id（加一段隨機字；免費的個人團隊不能用別人註冊過的）。
// 2. 在 Xcode 的 Signing & Capabilities 選你的 Team（Xcode 會把它寫進 project.pbxproj）。
// 3. 再跑一次：把 Team 從 project.pbxproj 搬到 signing.local.xcconfig，pbxproj 回到原樣。不會把 Team 印出來。
// 用法：npm run setup-signing -w @running-coach/ios [-- --team XXXXXXXXXX]
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(here, "ios", "signing.local.xcconfig");
const pbxproj = join(here, "ios", "App", "App.xcodeproj", "project.pbxproj");

const local = existsSync(file) ? readFileSync(file, "utf8") : "";
const bundle = local.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(\S+)/)?.[1] ?? `com.zone2mate.app.dev${randomBytes(3).toString("hex")}`;
const arg = process.argv.indexOf("--team");
let team = (arg > 0 ? process.argv[arg + 1] : "") || local.match(/DEVELOPMENT_TEAM\s*=\s*(\S+)/)?.[1] || "";

const project = readFileSync(pbxproj, "utf8");
const fromXcode = project.match(/DEVELOPMENT_TEAM = ([A-Z0-9]{10});/)?.[1] ?? "";
if (fromXcode) {
  team ||= fromXcode;
  writeFileSync(pbxproj, project.replace(/^[\t ]*DEVELOPMENT_TEAM = [A-Z0-9]{10};\n/gm, ""));
  console.log("已把 Xcode 寫進 project.pbxproj 的 Team 拿掉（改放在 signing.local.xcconfig）");
}

const lines = ["// 這台 Mac 自己的簽章設定，不進版控（規格 12.49）", `PRODUCT_BUNDLE_IDENTIFIER = ${bundle}`];
if (/^[A-Z0-9]{10}$/.test(team)) lines.push(`DEVELOPMENT_TEAM = ${team}`);
writeFileSync(file, `${lines.join("\n")}\n`);

if (lines.length < 3) {
  console.log("已寫入 bundle id。下一步：npm run open -w @running-coach/ios → 左邊點 App → Signing & Capabilities → Team 選你的 Apple ID → 再跑一次這個指令。");
  process.exit(1);
}
console.log("已寫入 ios/signing.local.xcconfig（Team 不顯示）");
