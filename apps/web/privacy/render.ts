/**
 * 隱私說明頁（規格 12.20）：建置時把 page.html 填入這次建置的環境，輸出成 privacy.html 與 privacy.css
 * （Cloudflare Pages 把 privacy.html 提供在 /privacy）. 頁面不用 JavaScript，套用和 App 一樣的安全標頭與 CSP.
 *
 * 頁面的每一句都對照程式寫：改了資料存在哪裡、送到哪裡、送了什麼時，page.html 要跟著改，並在最下面的異動紀錄加一行.
 * 網頁版預設會連的外部網址都要寫在頁面上（apps/web/test/privacy-page.test.ts 會檢查）.
 */
import { readFileSync } from "node:fs";

export const PRIVACY_HTML_FILE = "privacy.html";
export const PRIVACY_CSS_FILE = "privacy.css";

export interface PrivacyBuild {
  /** staging 的建置（VITE_STAGING=1）：頁面上方標示 Staging，不讓搜尋引擎收錄 */
  staging: boolean;
  /** 這次建置的同步服務網址（VITE_SYNC_URL）；沒有設定時為空 */
  syncUrl: string;
  /** 功能開關 devices（裝置清單與移除，規格 12.27）開著：多寫伺服器多知道的事 */
  devices?: boolean;
  /** 功能開關 onboarding（設定精靈與先看看，規格 12.35 的 A、B）開著 */
  onboarding?: boolean;
  /** 這次建置設定了用 Intervals.icu 登入（VITE_INTERVALS_CLIENT_ID 與同步服務，規格 12.37） */
  intervalsLogin?: boolean;
  /** 這次建置提供免費試用（功能開關 trial 與 VITE_PROXY_URL，規格 12.39）：代理的網址 */
  trialProxyUrl?: string;
}

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 同步服務的主機名稱：網址不正確時為 null */
function hostOf(url: string): string | null {
  try {
    return url.trim() ? new URL(url.trim()).host : null;
  } catch {
    return null;
  }
}

export function renderPrivacyPage(build: PrivacyBuild): string {
  const host = hostOf(build.syncUrl);
  const trialHost = hostOf(build.trialProxyUrl ?? "");
  const replacements: Record<string, string> = {
    "<!--TRIAL_SUMMARY-->": trialHost
      ? "<li><strong>免費試用（邀請碼，選用）</strong>：選了才會用。對話會經過我們的代理轉送到 Anthropic；代理<strong>不保存對話的內容</strong>，只記試用帳號（隨機的代號）、每天用了幾則與每月的用量。</li>"
      : "",
    "<!--ACCOUNTS_SUMMARY-->": trialHost ? "除了免費試用的帳號（只有隨機的代號，沒有 email 或名字）之外沒有帳號；" : "目前沒有帳號；",
    "<!--ACCOUNTS_DONT-->": trialHost
      ? "除了免費試用的帳號之外沒有帳號；試用帳號不需要 email、名字或手機號碼。之後如果推出需要登入的功能，會先在這一頁說明收集哪些資料、存在哪裡。"
      : "目前沒有帳號。之後如果推出需要帳號的功能（例如訂閱），會先在這一頁說明收集哪些資料、存在哪裡。",
    "<!--TRIAL_SENT-->": trialHost
      ? `<h3>免費試用的代理（選了「免費試用（邀請碼）」才會）</h3>
        <ul>
          <li><strong>什麼時候</strong>：輸入邀請碼時（送出邀請碼，換到這台的試用憑證）；之後和教練對話、教練分析一趟跑步、整理較早的對話、「從其他 AI 帶入」，以及查今天還剩幾則時。</li>
          <li><strong>送什麼</strong>：和上面「你選的 AI 服務」一樣的內容，加上試用憑證（代替 API key）與這次是對話、自動分析還是整理對話（用來算每天的則數）。</li>
          <li><strong>送到哪裡</strong>：我們放在 Cloudflare Workers 上的代理（<code>${escapeHtml(trialHost)}</code>），由它用作者的 API key 轉送到 <code>api.anthropic.com</code>（Anthropic）。模型固定是 Claude Haiku。</li>
          <li><strong>代理存什麼</strong>：
            <ul>
              <li>邀請碼的雜湊（不是邀請碼本身）、有沒有用過、到期日；</li>
              <li>試用帳號：隨機的代號、是否停用、建立的時間、怎麼建立的（邀請碼的雜湊）；</li>
              <li>用著這個帳號的每台裝置：試用憑證的雜湊、粗略的名稱（例「iPhone · Safari」，讓你在裝置清單分得出是哪一台）、加入與最後使用的時間；</li>
              <li>「在另一台使用」的連結碼：只存雜湊，10 分鐘後失效、用一次；</li>
              <li>每天用了幾則對話、幾次自動分析與整理對話（只有次數）；</li>
              <li>每個月的請求數、token 數與金額。</li>
            </ul>
          </li>
          <li><strong>不存什麼</strong>：對話、選手資料、訓練紀錄等任何內容都只在記憶體中轉送，不寫進資料庫或紀錄；不存 email、名字或 IP 位址。代理的紀錄只有帳號代號、模型、狀態碼與 token 數。</li>
          <li><strong>存多久</strong>：每天的次數 90 天、每月的用量 13 個月，到期自動刪除；所有試用的人這個月合計的金額另外記（用來控管總預算，不分是誰的）。</li>
          <li><strong>誰看得到</strong>：Zone2Mate 的作者（看用量、停用帳號）；看不到你的對話。</li>
          <li>試用憑證只存在這台裝置的瀏覽器（密碼鎖開著時加密），不會同步；要在另一台用，在設定按「在另一台使用」拿一個連結碼，在那台輸入（同一個帳號、同一份額度）。</li>
          <li>Anthropic 看得到轉送的內容，如何保存與使用依它的<a href="https://www.anthropic.com/legal/privacy">條款與隱私政策</a>。</li>
        </ul>`
      : "",
    "<!--TRIAL_CONTROL-->": trialHost
      ? "<li><strong>移除某一台</strong>：設定 →「AI 教練」的裝置清單按「移除」，那台的登入馬上失效。</li><li><strong>刪除試用帳號</strong>：設定 →「AI 教練」→「刪除試用帳號」，馬上刪掉代理那邊的帳號、所有裝置的登入、每天的次數與每月的用量（這個月合計的金額不分是誰的，不會刪）；也可以寫信請我們刪除。</li>"
      : "",
    "<!--TRIAL_CHANGE-->": trialHost
      ? "<li>2026-11-10：免費試用（邀請碼）：對話經過我們的代理轉送到 Anthropic，不保存內容，只記次數與用量；可以在另一台裝置使用、移除某一台、自己刪除試用帳號。</li>"
      : "",
    "<!--HEAD-->": build.staging ? '<meta name="robots" content="noindex" />' : "",
    "<!--STAGING-->": build.staging
      ? '<div class="staging-banner"><strong>Staging</strong>：還沒上線的測試版，資料與同步都和正式版分開。</div>'
      : "",
    "<!--SYNC_HOST-->": host ? `<code>${escapeHtml(host)}</code>` : "這個版本沒有設定同步服務",
    "<!--DEVICES-->": build.devices
      ? "<li>每台裝置：隨機的裝置代號、這台的兩把公開金鑰（驗證這台的請求、換金鑰時把新的金鑰加密給它）、加入與最後同步的時間、是否已被移除；裝置的名稱與平台以同步金鑰加密，我們看不到。所以同步服務知道一個同步空間有幾台、各自什麼時候加入與最後同步，但不知道是哪些裝置、是誰的；</li>" +
        "<li>換過金鑰（移除某台）的同步空間：要搬到哪個新的空間、給留下的每台加密後的新同步金鑰、被移除的裝置的證明、換金鑰的那台簽的聲明（只有裝置代號與雜湊；新金鑰都是加密的，我們解不開）；舊空間的資料在換金鑰時刪掉；</li>" +
        "<li>每個請求的一次性亂數，用來擋下重送的請求，十分鐘後刪除。</li>"
      : "",
    "<!--DEVICES_NOTE-->": build.devices
      ? "<li>移除某台裝置時，被移除的那台之後連不上同步，下次打開時會清掉它的同步金鑰與 API key（訓練資料留在那台，由那台的人決定清除或匯出）；它在移除前已經下載的資料我們收不回來。</li>"
      : "",
    "<!--ONBOARDING_STORED-->": build.onboarding
      ? "<li><strong>「先看看」的範例</strong>：第一次打開時可以先用範例的資料逛一圈。範例的資料只在這個分頁的記憶體裡，不寫進上面的資料庫、不讀你存的 key、不同步、不連任何外部服務；離開（按「開始設定」或關掉分頁）就清掉。設定精靈走到哪一步記在 localStorage。</li>"
      : "",
    "<!--ONBOARDING_AI-->": build.onboarding
      ? "；第一次設定時，貼上 key 會先打一次最小的請求檢查能不能用（只送「ping」這個字，不含你的資料）"
      : "",
    "<!--ONBOARDING_CHANGE-->": build.onboarding
      ? "<li>2026-11-02：第一次打開時的設定精靈（貼上 key 時檢查能不能用，只送「ping」）與「先看看」的範例（只在記憶體裡，不存、不連外部服務）。</li>"
      : "",
    "<!--INTERVALS_LOGIN-->": build.intervalsLogin
      ? "<li><strong>用 Intervals.icu 登入（選用）</strong>：按「用 Intervals.icu 登入」時，你在 Intervals.icu 按同意後，它給的一次性授權碼會經過我們的同步服務轉送一次，換成只能讀你自己資料的 token（要用到只有我們有的 App 密碼，所以要經過伺服器）；同步服務不保存授權碼與 token、不留紀錄。token 只存在這台裝置的瀏覽器（密碼鎖開著時加密），不會同步；之後由瀏覽器直接帶著 token 向 Intervals.icu 讀資料。權限只有讀：活動、恢復資料、運動設定。按「中斷連結」會請 Intervals.icu 取消授權並刪掉這台的 token；也可以在 Intervals.icu 的設定頁移除 Zone2Mate。</li>"
      : "",
    "<!--INTERVALS_LOGIN_CHANGE-->": build.intervalsLogin
      ? "<li>2026-11-02：可以用 Intervals.icu 登入（授權碼經過同步服務轉送一次換成 token，不保存；token 只存在你的裝置）。</li>"
      : "",
    "<!--DEVICES_CHANGE-->": build.devices ? "<li>2026-10-27：多裝置同步可以看到有哪些裝置、移除某台（同步服務多記每台的公開金鑰與時間）。</li>" : "",
  };
  let html = read("page.html");
  for (const [mark, value] of Object.entries(replacements)) {
    if (!html.includes(mark)) throw new Error(`隱私說明頁的範本少了 ${mark}`);
    html = html.replace(mark, value);
  }
  return html;
}

export function privacyCss(): string {
  return read("page.css");
}
