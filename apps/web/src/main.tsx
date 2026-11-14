import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { DEMO } from "./demo";
import { captureLoginCallback } from "./intervals-login";
import { PASSKEY_TEST_ON } from "./environment";
import { PASSKEY_TEST_HASH } from "./passkey-test";
import { needsUnlock } from "./settings";
import { TabGate } from "./views/TabGate";
import { UnlockView } from "./views/Unlock";
import { PasskeyTestView } from "./views/PasskeyTest";
import "./styles.css";

// 從 Intervals.icu 登入回來（規格 12.37）：在任何外部請求之前讀走網址上的 code 並清掉
captureLoginCallback();

// passkey 的測試頁（規格 12.44，只在 staging 與開發）：不開資料庫、不用解密碼鎖，和 App 分開。
// 進出這一頁（網址的 # 後面改變）時重新載入，App 的資料庫不會在同一個頁面裡開兩次
const passkeyTest = () => PASSKEY_TEST_ON && location.hash === PASSKEY_TEST_HASH;
const PASSKEY_TEST = passkeyTest();
if (PASSKEY_TEST_ON) {
  window.addEventListener("hashchange", () => {
    if (passkeyTest() !== PASSKEY_TEST) location.reload();
  });
}

function Root() {
  const [locked, setLocked] = useState(needsUnlock);
  if (PASSKEY_TEST) return <PasskeyTestView />;
  // 「先看看」的範例用記憶體裡的資料庫、不讀存著的 key：不用搶另一個分頁的資料庫，也不用解密碼鎖（規格 12.35 的 B）
  if (DEMO) return <App />;
  // 另一個分頁開著時先問要不要在這裡用（KI-046），再解密碼鎖
  return <TabGate>{locked ? <UnlockView onUnlocked={() => setLocked(false)} /> : <App />}</TabGate>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
