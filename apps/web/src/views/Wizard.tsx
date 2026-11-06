import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  checkLlmKey,
  IntervalsClient,
  recordWithOf,
  TERMS_VERSION,
  type KeyCheck,
} from "@running-coach/core";

import { ChevronLeft, CircleCheck, ExternalLink, PencilLine, Sparkles, Watch, type LucideIcon } from "lucide-react";

import { errorText, useApp, type Tab } from "../app-context";
import { featureEnabled } from "../environment";
import { startDemo } from "../demo";
import { buildProvider, consentKey, intervalsConnected, PROVIDER_LABELS, resolvedModels, suggestedModels, type AppSettings, type ProviderKind } from "../settings";
import { useSync } from "../use-sync";
import { finishWizard, saveWizardStep, wizardSteps, type WizardStep } from "../wizard";
import { Disclosure, Icon } from "../ui";
import { FirstSync } from "./FirstSync";
import { IntervalsGuide, RecordWithPicker, SportsStep } from "./GettingStarted";
import { ManualRunForm } from "./ManualRun";
import { SyncNotice } from "./PhoneGuide";
import { PrivacyLink } from "./PrivacyLink";
import { DataFlow } from "./Settings";
import { TermsShort } from "./TermsLink";
import { IntervalsLogin, intervalsLoginAvailable } from "./IntervalsLogin";
import { peekLoginCallback } from "../intervals-login";

/** 精靈裡可以選的 AI（其他相容服務、訂閱在設定頁填） */
type WizardProvider = Exclude<ProviderKind, "openai-compatible">;

/** 「去拿 key」：直接開到產生 key 的那一頁，旁邊寫要按的按鈕（截圖之後由使用者提供再補，規格 9.4） */
const KEY_PAGES: Record<WizardProvider, { url: string; site: string; steps: ReactNode[]; sub: string }> = {
  anthropic: {
    url: "https://console.anthropic.com/settings/keys",
    site: "Claude Console",
    sub: "教練的品質最好（建議）",
    steps: [
      "登入（沒有帳號就按 Sign up 註冊）。",
      <>左邊的 <strong>Billing</strong> 先儲值（最少 5 美元），沒有額度 key 不能用。</>,
      <>回到 <strong>API keys</strong>，按 <strong>Create Key</strong>，名字填 Zone2Mate，按 <strong>Add</strong>。</>,
      "按複製，回到這裡貼上。key 只會顯示這一次。",
    ],
  },
  openai: {
    url: "https://platform.openai.com/api-keys",
    site: "OpenAI Platform",
    sub: "ChatGPT 的公司",
    steps: [
      "登入（沒有帳號就註冊）。",
      <>右上角的齒輪 → <strong>Billing</strong> 先儲值，沒有額度 key 不能用。</>,
      <>回到 <strong>API keys</strong>，按 <strong>Create new secret key</strong>，名字填 Zone2Mate，按 <strong>Create secret key</strong>。</>,
      "按 Copy，回到這裡貼上。key 只會顯示這一次。",
    ],
  },
  gemini: {
    url: "https://aistudio.google.com/apikey",
    site: "Google AI Studio",
    sub: "Google 的 AI",
    steps: [
      "用 Google 帳號登入。",
      <>按 <strong>Create API key</strong>（第一次會請你建立或選一個專案）。</>,
      "按複製，回到這裡貼上。",
      "免費的 key 有次數上限，Google 也可能拿免費層的內容改進模型；要穩定用請在 Google Cloud 開通付費。",
    ],
  },
};

const WIZARD_PROVIDERS = Object.keys(KEY_PAGES) as WizardProvider[];

/** 一頁：上一步、第幾步、標題、內容、最下面一顆主要按鈕 */
function Page({
  step,
  steps,
  onBack,
  title,
  sub,
  children,
  footer,
}: {
  step: WizardStep;
  steps: WizardStep[];
  onBack?: () => void;
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const index = steps.indexOf(step);
  const heading = useRef<HTMLHeadingElement>(null);
  // 換頁時焦點移到標題，螢幕閱讀器從這一頁的開頭讀起
  useEffect(() => heading.current?.focus(), [step]);
  return (
    <section className="wizard-page" data-step={step}>
      {onBack && (
        <div className="wizard-head">
          <button className="back-button" onClick={onBack}>
            <Icon as={ChevronLeft} />
            上一步
          </button>
          <span className="small muted" aria-label={`第 ${index} 步，共 ${steps.length - 1} 步`}>
            {index} / {steps.length - 1}
          </span>
        </div>
      )}
      <h2 className="title" ref={heading} tabIndex={-1}>
        {title}
      </h2>
      {sub && <p className="muted">{sub}</p>}
      <div className="wizard-body">{children}</div>
      {footer && <div className="wizard-foot">{footer}</div>}
    </section>
  );
}

/** 選一個（供應商、紀錄的來源）：和「你用什麼記錄跑步」同一種選項 */
function Choices<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: { id: T; icon: LucideIcon; title: string; sub: string }[];
  value: T | null;
  onPick: (id: T) => void;
}) {
  return (
    <fieldset className="choices" aria-label={label}>
      {options.map((c) => (
        <label key={c.id} className={`choice${value === c.id ? " selected" : ""}`}>
          <input type="radio" name={label} checked={value === c.id} onChange={() => onPick(c.id)} />
          <span className="list-row-icon">
            <Icon as={c.icon} />
          </span>
          <span className="list-row-text">
            <span className="list-row-title">{c.title}</span>
            <span className="list-row-sub">{c.sub}</span>
          </span>
          {value === c.id && <Icon as={CircleCheck} className="icon choice-check" />}
        </label>
      ))}
    </fieldset>
  );
}

type KeyState = { kind: "idle" } | { kind: "checking" } | { kind: "ok" } | { kind: "error"; text: string };

/** 檢查用的模型：Claude 用最便宜的（跑後摘要的模型），其他的用選手填的 */
function checkModel(s: AppSettings): string {
  return s.provider === "anthropic" ? resolvedModels(s).summary : s.models.chat.trim();
}

/** 貼上 key 就檢查並自動存（規格 12.35 的 A）：不用另外按儲存 */
function KeyStep({ provider, onOk }: { provider: WizardProvider; onOk: (ok: boolean) => void }) {
  const { settings, updateSettings } = useApp();
  const page = KEY_PAGES[provider];
  const needsModel = provider !== "anthropic";
  const [key, setKey] = useState(settings.provider === provider ? settings.apiKey : "");
  const [model, setModel] = useState(settings.provider === provider ? settings.models.chat : "");
  const [state, setState] = useState<KeyState>(() => (settings.provider === provider && settings.apiKey ? { kind: "ok" } : { kind: "idle" }));
  const latest = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => onOk(state.kind === "ok"), [state, onOk]);

  useEffect(() => {
    const apiKey = key.trim();
    const chat = model.trim();
    const current = settingsRef.current;
    if (!apiKey || (needsModel && !chat)) {
      setState({ kind: "idle" });
      return;
    }
    // 已經存好、沒改的不再檢查
    if (current.provider === provider && current.apiKey === apiKey && (!needsModel || current.models.chat === chat)) {
      setState({ kind: "ok" });
      return;
    }
    const id = ++latest.current;
    setState({ kind: "checking" });
    // 打字或貼上之後停一下才檢查，不要每個字都打一次 API
    const timer = setTimeout(() => {
      const models = needsModel ? { chat, summary: "", compress: "" } : suggestedModels("byok", provider);
      const next: AppSettings = { ...settingsRef.current, llmMode: "byok", provider, apiKey, models };
      void checkLlmKey(buildProvider(next), checkModel(next)).then(async (result: KeyCheck) => {
        if (id !== latest.current) return;
        if (!result.ok) {
          setState({ kind: "error", text: result.message });
          return;
        }
        try {
          await updateSettings(next);
          setState({ kind: "ok" });
        } catch (e) {
          setState({ kind: "error", text: `存不起來：${errorText(e)}` });
        }
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [key, model, provider, needsModel, updateSettings]);

  return (
    <>
      <a className="button" href={page.url} target="_blank" rel="noreferrer">
        <Icon as={ExternalLink} />
        去 {page.site} 拿 key
      </a>
      <ol className="guide small">
        {page.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {needsModel && (
        <label>
          模型名稱
          <input value={model} placeholder={provider === "openai" ? "例：gpt-5" : "例：gemini-2.5-pro"} onChange={(e) => setModel(e.target.value)} />
        </label>
      )}
      <label>
        API key
        <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <p className="key-state" role="status">
        {state.kind === "checking" && <span className="muted small">檢查中…</span>}
        {state.kind === "ok" && (
          <span className="ok-text">
            <Icon as={CircleCheck} /> 可以用，已存在這個瀏覽器
          </span>
        )}
        {state.kind === "error" && <span className="field-error">{state.text}</span>}
      </p>
    </>
  );
}

type Source = "intervals" | "manual";

/** Intervals.icu 的 API key：貼上就檢查並自動存 */
function IntervalsKey() {
  const { settings, updateSettings, coach } = useApp();
  const [key, setKey] = useState(settings.intervals.apiKey);
  const [state, setState] = useState<KeyState>(() => (settings.intervals.apiKey ? { kind: "ok" } : { kind: "idle" }));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const latest = useRef(0);
  useEffect(() => {
    const apiKey = key.trim();
    if (!apiKey) {
      setState({ kind: "idle" });
      return;
    }
    if (apiKey === settingsRef.current.intervals.apiKey) return;
    const id = ++latest.current;
    setState({ kind: "checking" });
    const timer = setTimeout(() => {
      const client = new IntervalsClient({ apiKey, today: () => coach.today(), baseUrl: import.meta.env.VITE_INTERVALS_BASE_URL });
      client
        .fetchSportSettings()
        .then(async () => {
          if (id !== latest.current) return;
          await updateSettings({ ...settingsRef.current, intervals: { ...settingsRef.current.intervals, apiKey } });
          setState({ kind: "ok" });
        })
        .catch((e) => {
          if (id !== latest.current) return;
          const text = errorText(e);
          setState({
            kind: "error",
            text: /401|403|Unauthorized|Forbidden/i.test(text) ? "key 不對：到 Intervals.icu 的 Settings 重新複製一次。" : `連不上 Intervals.icu：${text}`,
          });
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [key, coach, updateSettings]);
  return (
    <>
      <IntervalsGuide where="下面的「API key」" />
      <label>
        API key
        <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <p className="key-state" role="status">
        {state.kind === "checking" && <span className="muted small">檢查中…</span>}
        {state.kind === "ok" && (
          <span className="ok-text">
            <Icon as={CircleCheck} /> 連上了
          </span>
        )}
        {state.kind === "error" && <span className="field-error">{state.text}</span>}
      </p>
    </>
  );
}

/** 設定精靈：一次一件事、一個主要按鈕、可以上一步；中途離開再回來從停下的那一步繼續 */
export function Wizard({ start, onFinish }: { start: WizardStep; onFinish: (target?: Tab | "sync" | "ai") => void }) {
  const { coach, settings, updateSettings, revision, touch } = useApp();
  const multisport = featureEnabled("multisport");
  const steps = wizardSteps(multisport);
  const [step, setStepState] = useState<WizardStep>(steps.includes(start) ? start : "welcome");
  const [profile, setProfile] = useState<Record<string, string> | null>(null);
  const [counts, setCounts] = useState({ workouts: 0, others: 0 });
  const [provider, setProvider] = useState<WizardProvider | null>(() =>
    settings.llmMode === "byok" && settings.provider !== "openai-compatible" && settings.apiKey ? settings.provider : null,
  );
  const [keyOk, setKeyOk] = useState(false);
  const connected = intervalsConnected(settings);
  // 從 Intervals.icu 登入回來時停在「紀錄從哪裡來？」，Intervals.icu 選好
  const [source, setSource] = useState<Source | null>(connected || peekLoginCallback()?.from === "wizard" ? "intervals" : null);
  const sync = useSync();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([coach.db.getProfile(), coach.db.countWorkouts(), coach.db.countOtherActivities()]).then(([p, workouts, others]) => {
      setProfile(p);
      setCounts({ workouts, others });
    });
  }, [coach, revision]);

  const go = (next: WizardStep) => {
    saveWizardStep(next);
    setError(null);
    setStepState(next);
    document.querySelector(".wizard")?.scrollTo({ top: 0 });
  };
  const at = steps.indexOf(step);
  const back = at > 0 ? () => go(steps[at - 1]!) : undefined;
  const forward = () => go(steps[at + 1]!);
  const finish = (target?: Tab | "sync" | "ai") => {
    finishWizard();
    onFinish(target);
  };

  if (!profile) return null;
  const recordWith = recordWithOf(profile);
  const page = { step, steps, onBack: back };
  const primary = (label: string, onClick: () => void, disabled = false) => (
    <div className="actions full">
      <button className="primary" disabled={disabled} onClick={onClick}>
        {label}
      </button>
    </div>
  );

  switch (step) {
    case "welcome":
      return (
        <Page
          {...page}
          onBack={undefined}
          title="Zone2Mate"
          sub="你的 AI 跑步教練：依你的紀錄排課表、看每一趟、陪你練到比賽。"
          footer={
            <>
              <div className="actions full">
                <button className="primary" onClick={forward}>
                  開始設定
                </button>
              </div>
              <div className="actions full">
                <button onClick={startDemo}>先看看</button>
              </div>
              <div className="actions wizard-more">
                <button className="text" onClick={() => finish("sync")}>
                  在別台用過？用同步帶過來
                </button>
              </div>
            </>
          }
        >
          <ul className="wizard-points">
            <li>
              <Icon as={Watch} /> 讀你手錶的紀錄，或跑完自己記一筆
            </li>
            <li>
              <Icon as={Sparkles} /> 用你自己的 AI 帳號，資料存在你的裝置上
            </li>
          </ul>
          <p className="small muted">「先看看」用範例的資料逛一圈，不用設定，也不會存下任何東西。</p>
        </Page>
      );

    case "record":
      return (
        <Page {...page} title="你用什麼記錄跑步？" footer={primary("繼續", forward, recordWith === null)}>
          <RecordWithPicker value={recordWith} onPicked={() => touch()} />
        </Page>
      );

    case "provider":
      return (
        <Page
          {...page}
          title="選一個 AI"
          sub="教練用你自己的 AI 帳號，費用由那個帳號支付（一般一個月幾十到一兩百台幣）。"
          footer={
            <>
              {primary("繼續", forward, provider === null)}
              <div className="actions wizard-more">
                <button className="text" onClick={() => finish("ai")}>
                  其他服務或訂閱：到設定填
                </button>
              </div>
            </>
          }
        >
          <Choices
            label="選一個 AI"
            value={provider}
            options={WIZARD_PROVIDERS.map((p) => ({ id: p, icon: Sparkles, title: PROVIDER_LABELS[p], sub: KEY_PAGES[p].sub }))}
            onPick={setProvider}
          />
        </Page>
      );

    case "key":
      if (!provider) {
        go("provider");
        return null;
      }
      return (
        <Page {...page} title={`貼上 ${PROVIDER_LABELS[provider]} 的 key`} footer={primary("繼續", forward, !keyOk)}>
          <KeyStep key={provider} provider={provider} onOk={setKeyOk} />
        </Page>
      );

    case "consent": {
      const accept = async () => {
        try {
          const key = consentKey(settings);
          await updateSettings({
            ...settings,
            consents: [...settings.consents.filter((c) => c !== key), key],
            terms: { version: TERMS_VERSION, date: coach.today() },
          });
          forward();
        } catch (e) {
          setError(`存不起來：${errorText(e)}`);
        }
      };
      return (
        <Page
          {...page}
          title="資料會送到哪裡"
          footer={
            <>
              {error && <p className="field-error">{error}</p>}
              {primary("同意並繼續", () => void accept())}
            </>
          }
        >
          <DataFlow draft={settings} locked={false} />
          <TermsShort className="small muted" />
          <p className="small muted">按「同意並繼續」代表你同意上面的資料流向，也讀過使用須知。</p>
        </Page>
      );
    }

    case "source": {
      const watch = recordWith === "watch";
      const options = [
        { id: "intervals" as const, icon: Watch, title: "連接 Intervals.icu", sub: watch ? "手錶的紀錄自動進來（建議）" : "iPhone 可以用 Intervals.icu Companion 自動上傳" },
        { id: "manual" as const, icon: PencilLine, title: "手動記", sub: watch ? "先不連，跑完自己記一筆" : "跑完在這裡記日期、距離、時間和體感（建議）" },
      ];
      return (
        <Page
          {...page}
          title="紀錄從哪裡來？"
          footer={primary("繼續", forward, source === null || (source === "intervals" && !connected))}
        >
          <Choices label="紀錄從哪裡來" value={source} options={watch ? options : [options[1]!, options[0]!]} onPick={setSource} />
          {source === "intervals" && (
            <div className="stack">
              <IntervalsLogin from="wizard" />
              {intervalsLoginAvailable() ? (
                !settings.intervals.accessToken && (
                  <Disclosure summary="用 API key 連接（進階）" className="small">
                    <IntervalsKey />
                  </Disclosure>
                )
              ) : (
                <IntervalsKey />
              )}
            </div>
          )}
        </Page>
      );
    }

    case "sports":
      return (
        <Page {...page} title="你練哪些運動？" footer={primary("繼續", forward, !profile.pref_sports)}>
          <SportsStep profile={profile} onSaved={touch} />
        </Page>
      );

    case "first": {
      const done = counts.workouts > 0 || counts.others > 0;
      if (source === "intervals" || (source === null && connected)) {
        return (
          <Page
            {...page}
            title="抓進你的紀錄"
            sub="教練要看你最近的紀錄才知道近況。"
            footer={
              done ? (
                primary("繼續", forward)
              ) : (
                <div className="actions wizard-more">
                  <button className="text" onClick={forward}>
                    之後再抓
                  </button>
                </div>
              )
            }
          >
            {done ? (
              <p className="ok-text">
                <Icon as={CircleCheck} /> 抓好了，教練會看
              </p>
            ) : (
              <FirstSync sync={sync} />
            )}
            {sync.message?.kind === "error" ? <div className="notice error">{sync.message.text}</div> : <SyncNotice message={sync.message} />}
          </Page>
        );
      }
      return (
        <Page
          {...page}
          title="記第一筆"
          sub="最近一次跑步的日期、距離、時間和體感；沒有心率也可以。"
          footer={
            done ? (
              primary("繼續", forward)
            ) : (
              <div className="actions wizard-more">
                <button className="text" onClick={forward}>
                  之後再記
                </button>
              </div>
            )
          }
        >
          {done ? (
            <p className="ok-text">
              <Icon as={CircleCheck} /> 記好了，教練會看
            </p>
          ) : (
            <ManualRunForm onSaved={() => touch()} />
          )}
        </Page>
      );
    }

    case "profile":
      return (
        <Page
          {...page}
          title="讓教練更認識你"
          sub={recordWith === "watch" ? "目標、個人最佳、最大心率等，建議會更貼近你。" : "目標、5 km 或 10 km 的個人最佳等，教練才算得出你的配速。"}
          footer={
            <>
              {primary("填選手資料", () => finish("profile"))}
              <div className="actions wizard-more">
                <button className="text" onClick={() => finish("chat")}>
                  略過，開始用
                </button>
              </div>
            </>
          }
        >
          <p className="small muted">
            也可以之後在「選手」頁填，或從其他 AI 帶入。資料存在你的裝置上，見 <PrivacyLink />。
          </p>
        </Page>
      );
  }
}
