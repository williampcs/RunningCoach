import { useState } from "react";

import { errorText } from "../app-context";
import { WrongPasswordError } from "../key-lock";
import { forgetLockedSecrets, unlock } from "../settings";

/** 啟用密碼鎖後，每次開啟頁面先輸入密碼；解鎖前不開啟資料庫 */
export function UnlockView({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
      onUnlocked();
    } catch (e) {
      setError(e instanceof WrongPasswordError ? "密碼不正確，請再試一次。" : `無法解鎖：${errorText(e)}`);
      setBusy(false);
    }
  }

  function forget() {
    const ok = confirm(
      "忘記密碼時，只能刪除加密保存的 API key，之後重新填寫。\n其他設定、對話與訓練紀錄都會保留。確定要刪除嗎？",
    );
    if (!ok) return;
    forgetLockedSecrets();
    onUnlocked();
  }

  return (
    <main className="page unlock">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>Running Coach</h1>
        <p className="small">API key 已用密碼鎖保護，輸入密碼解鎖。</p>
        <label>
          密碼
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <div className="notice error">{error}</div>}
        <div className="row between">
          <button type="submit" className="primary" disabled={busy || password === ""}>
            {busy ? "解鎖中…" : "解鎖"}
          </button>
          <button type="button" className="link" onClick={forget}>
            忘記密碼
          </button>
        </div>
      </form>
    </main>
  );
}
