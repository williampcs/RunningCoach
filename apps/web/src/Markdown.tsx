import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 模型回覆與訓練計畫都是 Markdown；react-markdown 不會執行內容中的 HTML.
 * 不顯示圖片：模型回覆若被誘導放進外部圖片，載入圖片時網址就能把資料帶出去。
 * 連結：App 裡的 #help/… 照常切換；其他（例如隱私說明頁）在新分頁打開，不離開 App。
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={["img"]}
        components={{
          a: ({ node: _node, href, ...props }) =>
            href?.startsWith("#") ? <a href={href} {...props} /> : <a href={href} target="_blank" rel="noreferrer" {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
