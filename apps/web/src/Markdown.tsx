import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 模型回覆與訓練計畫都是 Markdown；react-markdown 不會執行內容中的 HTML.
 * 不顯示圖片：模型回覆若被誘導放進外部圖片，載入圖片時網址就能把資料帶出去。
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
