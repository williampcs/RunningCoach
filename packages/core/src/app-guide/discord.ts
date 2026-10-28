/**
 * Discord bot 的功能說明（規格 12.12）. 指令名稱要和 apps/discord 的指令一致（測試會檢查）.
 */
import { TERMS_SHORT } from "../terms";
import type { GuideSection } from "./index";

export const DISCORD_GUIDE: GuideSection[] = [
  {
    id: "chat",
    title: "和教練對話",
    keywords: ["對話", "訊息", "頻道"],
    body: `在指定的頻道直接傳訊息就是和教練對話；其他頻道不回應。跑完也可以直接說“剛跑完 8K，體感 7”，教練會去 Intervals.icu 抓數據。`,
  },
  {
    id: "commands",
    title: "指令",
    keywords: ["指令", "/sync", "/plan", "/profile", "/status", "/help", "同步"],
    body: `- \`/help\`：教練的自我介紹、指令與使用須知的連結。
- \`/sync\`：同步 Intervals.icu 的資料，並合併暫存的跑後感受。
- \`/plan\`：更新本週的訓練計畫（貼上計畫內容）。
- \`/profile\`：設定一個選手資料欄位，例如 goal_long_term、injuries。
- \`/status\`：顯示模型設定與記憶的狀態。`,
  },
  {
    id: "terms",
    title: "使用須知",
    keywords: ["免責", "使用須知", "醫療", "醫師", "受傷", "責任", "你是誰", "介紹"],
    body: `${TERMS_SHORT}

完整的使用須知在網頁版的「使用須知」頁，\`/help\` 會附上連結：不是醫療建議、哪些情況要先問醫師、立刻停止並就醫的警訊、AI 會出錯、資料的正確性、你的責任等。`,
  },
  {
    id: "memories",
    title: "記住的事",
    keywords: ["記住", "忘記", "記憶"],
    body: `跟教練說“幫我記住…”，它會記下來，每次對話都會考慮；說“忘掉…”就會刪掉。Discord 版沒有查看清單的畫面，可以請教練列出它記得的事。`,
  },
  {
    id: "weather",
    title: "天氣",
    keywords: ["天氣", "城市", "下雨", "濕熱", "WEATHER_LOCATION"],
    body: `部署時在 .env 設定 WEATHER_LOCATION（“緯度,經度”，會四捨五入到約 10 公里），教練就會參考約略的天氣：今天的天氣、未來幾天的預報與跑步當下的溫度、露點。座標只用來向 Open-Meteo 查天氣，不存進資料庫、不給模型看。沒設定時教練不參考天氣。`,
  },
  {
    id: "web",
    title: "網頁版",
    keywords: ["網頁", "手機", "App", "多裝置"],
    body: `網頁版有更多畫面：運動的回報、紀錄與累積、課表的調整、選手資料與記住的事、多裝置同步。Discord bot 和網頁版的資料是分開的，不會同步。`,
  },
];
