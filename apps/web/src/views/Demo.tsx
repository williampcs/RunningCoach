import { Eye } from "lucide-react";

import { endDemo } from "../demo";
import { Icon } from "../ui";

/** 範例的標示（規格 12.35 的 B）：最上面一直顯示「這是範例」＋「開始設定」 */
export function DemoBanner() {
  return (
    <div className="notice info demo-banner" role="status">
      <span>
        <Icon as={Eye} size={16} /> 這是範例，資料都是假的，離開就清掉。
      </span>
      <button className="primary" onClick={endDemo}>
        開始設定
      </button>
    </div>
  );
}

/** 範例裡的設定：不能改設定、同步或匯出 */
export function DemoSettings() {
  return (
    <div className="stack">
      <section className="card">
        <h2>範例裡不能改設定</h2>
        <p className="small muted">範例不讀你的 key、不同步、不匯出，也不連任何外部服務。開始設定後就能用全部的功能。</p>
        <div className="actions full">
          <button className="primary" onClick={endDemo}>
            開始設定
          </button>
        </div>
      </section>
    </div>
  );
}

/** 範例裡的對話輸入框：開始設定後才能和教練聊（範例的對話是預先寫好的，不打 AI） */
export function DemoComposer() {
  return (
    <div className="notice info inline demo-composer">
      <span>開始設定後就能和教練聊。</span>
      <button className="text" onClick={endDemo}>
        開始設定
      </button>
    </div>
  );
}
