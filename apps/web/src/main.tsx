import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { needsUnlock } from "./settings";
import { UnlockView } from "./views/Unlock";
import "./styles.css";

function Root() {
  const [locked, setLocked] = useState(needsUnlock);
  return locked ? <UnlockView onUnlocked={() => setLocked(false)} /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
