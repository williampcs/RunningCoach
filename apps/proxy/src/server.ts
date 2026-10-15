/** 以 Node 的 http 伺服器執行代理（本機開發、容器部署）. */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    // Node 的 fetch 實作要求串流 body 時指定
    duplex: "half",
  } as RequestInit);
}

export function serve(handle: (request: Request) => Promise<Response>, port: number, host = "0.0.0.0"): Promise<Server> {
  const server = createServer((req, res) => {
    handle(toRequest(req))
      .then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) return void res.end();
        // 下游中斷連線時 pipeline 會取消上游的串流
        await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res);
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
