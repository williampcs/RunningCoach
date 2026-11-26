// 在你的 Mac 上寫 ios/signing.local.xcconfig（不進版控；規格 12.49）：
// Team 從這台 Mac 鑰匙圈裡的「Apple Development」憑證讀（Xcode 登入 Apple ID 並建過一次 App 後才有），
// bundle id 加一段隨機字（免費的個人團隊不能用別人註冊過的）。不會把 Team 印出來。
// 用法：npm run setup-signing -w @running-coach/ios [-- --team XXXXXXXXXX]
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(here, "ios", "signing.local.xcconfig");
const arg = process.argv.indexOf("--team");
let team = arg > 0 ? process.argv[arg + 1] : "";

if (!team) {
  try {
    const pem = execSync('security find-certificate -c "Apple Development" -p', { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const subject = execSync("openssl x509 -noout -subject -nameopt multiline", { input: pem }).toString();
    team = subject.match(/organizationalUnitName\s*=\s*([A-Z0-9]{10})/)?.[1] ?? "";
  } catch {
    team = "";
  }
}
if (!team) {
  // 還沒有憑證時：Xcode 登入 Apple ID 後記在它的設定裡
  try {
    const prefs = execSync("defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    team = prefs.match(/teamID = "?([A-Z0-9]{10})"?;/)?.[1] ?? "";
  } catch {
    team = "";
  }
}
if (!/^[A-Z0-9]{10}$/.test(team)) {
  console.error("找不到 Team：先在 Xcode 登入 Apple ID（設定 → Accounts），或用 -- --team 指定。");
  process.exit(1);
}

let bundle = "";
if (existsSync(file)) bundle = readFileSync(file, "utf8").match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(\S+)/)?.[1] ?? "";
if (!bundle) bundle = `com.zone2mate.app.dev${randomBytes(3).toString("hex")}`;

writeFileSync(file, `// 這台 Mac 自己的簽章設定，不進版控（規格 12.49）\nDEVELOPMENT_TEAM = ${team}\nPRODUCT_BUNDLE_IDENTIFIER = ${bundle}\n`);
console.log("已寫入 ios/signing.local.xcconfig（Team 不顯示）");
