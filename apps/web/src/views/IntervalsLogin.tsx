import { useEffect, useState } from "react";

import { INTERVALS_BASE_URL } from "@running-coach/core";

import { CircleCheck, LogIn } from "lucide-react";

import { errorText, useApp } from "../app-context";
import {
  disconnectIntervals,
  exchangeLoginCode,
  intervalsLoginConfigured,
  startIntervalsLogin,
  takeLoginCallback,
  type LoginFrom,
} from "../intervals-login";
import { Icon } from "../ui";
import { DEMO } from "../demo";
import { defaultSettings } from "../settings";

/** 這次建置能用 Intervals.icu 登入嗎（有 client_id 與同步服務；範例裡不能） */
export function intervalsLoginAvailable(): boolean {
  return !DEMO && intervalsLoginConfigured(defaultSettings().sync.url);
}

type State = { kind: "idle" } | { kind: "busy"; text: string } | { kind: "error"; text: string } | { kind: "note"; text: string };

/**
 * 用 Intervals.icu 登入（規格 12.37）：還沒連的顯示「用 Intervals.icu 登入」；登入過的顯示帳號與「中斷連結」.
 * 從 Intervals.icu 回來時（網址的 code 在 main.tsx 已經讀走並清掉）在這裡換 token 並存起來
 */
export function IntervalsLogin({ from }: { from: LoginFrom }) {
  const { settings, updateSettings, toast } = useApp();
  const [state, setState] = useState<State>({ kind: "idle" });
  const available = intervalsLoginAvailable();

  useEffect(() => {
    if (!available) return;
    const callback = takeLoginCallback();
    if (!callback) return;
    if (callback.kind === "denied") {
      setState({ kind: "error", text: "你在 Intervals.icu 沒有按同意，所以沒有連上。要連的話再按一次「用 Intervals.icu 登入」。" });
      return;
    }
    if (callback.kind === "invalid") {
      setState({ kind: "error", text: "登入沒有完成（可能是從別的分頁回來的），再按一次「用 Intervals.icu 登入」。" });
      return;
    }
    setState({ kind: "busy", text: "連接中…" });
    void (async () => {
      try {
        const account = await exchangeLoginCode(settings.sync.url, callback.code);
        await updateSettings({
          ...settings,
          intervals: { ...settings.intervals, accessToken: account.accessToken, account: { id: account.athleteId, name: account.athleteName } },
        });
        setState({ kind: "idle" });
        toast("已連上 Intervals.icu。");
      } catch (e) {
        setState({ kind: "error", text: errorText(e) });
      }
    })();
    // 只在打開時處理一次回呼
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!available) return null;
  const token = settings.intervals.accessToken;

  async function disconnect() {
    if (!confirm("中斷和 Intervals.icu 的連結？已經抓進來的紀錄會留著，之後不會再抓新的。")) return;
    setState({ kind: "busy", text: "中斷中…" });
    const revoked = await disconnectIntervals(token, import.meta.env.VITE_INTERVALS_BASE_URL || INTERVALS_BASE_URL);
    try {
      await updateSettings({ ...settings, intervals: { ...settings.intervals, accessToken: "", account: null } });
    } catch (e) {
      setState({ kind: "error", text: `刪不掉這台的登入：${errorText(e)}` });
      return;
    }
    if (revoked) {
      setState({ kind: "idle" });
      toast("已中斷和 Intervals.icu 的連結。");
    } else {
      setState({
        kind: "note",
        text: "這台的登入已經刪掉，但 Intervals.icu 沒有回應：請到 Intervals.icu 的設定頁，在已連接的 App 裡移除 Zone2Mate。",
      });
    }
  }

  return (
    <div className="intervals-login stack">
      {token ? (
        <div className="row">
          <span className="ok-text">
            <Icon as={CircleCheck} /> 已用 Intervals.icu 登入{settings.intervals.account?.name ? `：${settings.intervals.account.name}` : ""}
          </span>
          <button className="text danger" disabled={state.kind === "busy"} onClick={() => void disconnect()}>
            中斷連結
          </button>
        </div>
      ) : (
        <>
          <button disabled={state.kind === "busy"} onClick={() => startIntervalsLogin(from)}>
            <Icon as={LogIn} />
            {state.kind === "busy" ? state.text : "用 Intervals.icu 登入"}
          </button>
          <p className="small muted">到 Intervals.icu 按同意就好，不用複製 key；只讀你的活動、恢復資料與設定。</p>
        </>
      )}
      {state.kind === "busy" && token && <p className="small muted">{state.text}</p>}
      {state.kind === "error" && <p className="field-error">{state.text}</p>}
      {state.kind === "note" && <div className="notice warn">{state.text}</div>}
    </div>
  );
}
