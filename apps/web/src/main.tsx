import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { needsUnlock } from "./settings";
import { TabGate } from "./views/TabGate";
import { UnlockView } from "./views/Unlock";
import "./styles.css";

function Root() {
  const [locked, setLocked] = useState(needsUnlock);
  // 另一個分頁開著時先問要不要在這裡用（KI-046），再解密碼鎖
  return <TabGate>{locked ? <UnlockView onUnlocked={() => setLocked(false)} /> : <App />}</TabGate>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
