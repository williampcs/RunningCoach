import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { DEMO } from "./demo";
import { needsUnlock } from "./settings";
import { TabGate } from "./views/TabGate";
import { UnlockView } from "./views/Unlock";
import "./styles.css";

function Root() {
  const [locked, setLocked] = useState(needsUnlock);
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
