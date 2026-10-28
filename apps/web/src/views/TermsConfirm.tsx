import { useState } from "react";

import { TERMS_VERSION } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { TermsShort } from "./TermsLink";

/**
 * 用過 App、但還沒確認過這一版使用須知的人（規格 12.32）：打開時先確認一次. 確認前底下的畫面不能操作；
 * 第一次確認與使用須知改版後的說法不同
 */
export function TermsConfirm() {
  const { coach, settings, updateSettings } = useApp();
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updated = settings.terms !== null;

  async function accept() {
    try {
      await updateSettings({ ...settings, terms: { version: TERMS_VERSION, date: coach.today() } });
    } catch (e) {
      setError(`儲存失敗：${errorText(e)}`);
    }
  }

  return (
    <div className="terms-gate">
      <section className="card" role="dialog" aria-modal="true" aria-labelledby="terms-gate-title">
        <h2 id="terms-gate-title">{updated ? "使用須知更新了" : "請先看過使用須知"}</h2>
        <TermsShort className="small" />
        <p className="small muted">{updated ? "內容有重要的修改，請再看一次。" : "第一次使用時要確認一次，之後有重要的修改會再請你確認。"}</p>
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          我已閱讀使用須知
        </label>
        {error && <div className="notice error">{error}</div>}
        <div className="actions full">
          <button className="primary" disabled={!checked} onClick={() => void accept()}>
            繼續
          </button>
        </div>
      </section>
    </div>
  );
}
