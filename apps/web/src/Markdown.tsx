import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 模型回覆與訓練計畫都是 Markdown；react-markdown 不會執行內容中的 HTML */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
