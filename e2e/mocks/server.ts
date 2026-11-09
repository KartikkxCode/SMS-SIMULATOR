import http from "node:http";

export type MockCall = { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: Buffer };
export type MockReply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string>; delayMs?: number; dropConnection?: boolean };
export type MockHandler = (call: MockCall) => MockReply | Promise<MockReply>;

export type MockServer = { url: string; calls: MockCall[]; close(): Promise<void> };

/** A tiny HTTP server that records every request and answers with whatever `handler` returns. */
export async function startMock(handler: MockHandler): Promise<MockServer> {
  const calls: MockCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://mock");
      const call = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) };
      calls.push(call);
      const reply = await handler(call);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (reply.dropConnection) {
        req.socket.destroy();
        return;
      }
      const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? "");
      res.writeHead(reply.status ?? 200, { "content-type": reply.json !== undefined ? "application/json" : "text/plain", ...reply.headers });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const jsonBody = <T>(call: MockCall): T => JSON.parse(call.body.toString("utf8")) as T;
