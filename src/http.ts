export type RequestUrlFn = (p: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ArrayBuffer;
  throw: false;
}) => Promise<{ status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }>;

/** isomorphic-git 的 body 是异步迭代的分片；requestUrl 只收一整块，所以先合并。 */
export async function collectBody(body: unknown): Promise<Uint8Array | undefined> {
  if (!body) return undefined;
  const parts: Uint8Array[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) parts.push(c);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 用 Obsidian 的 requestUrl 实现 isomorphic-git 的 http 插件：绕开 CORS，桌面移动同一套。 */
export function makeHttp(requestUrl: RequestUrlFn) {
  return {
    async request(opts: {
      url: string; method?: string; headers?: Record<string, string>; body?: unknown;
    }) {
      const body = await collectBody(opts.body);
      const res = await requestUrl({
        url: opts.url,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
        body: body
          ? (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
          : undefined,
        // 必须 false：默认 true 时 4xx/5xx 会抛异常，isomorphic-git 拿不到状态码，
        // 401（令牌过期）就退化成一个无法辨认的错误。
        throw: false,
      });
      return {
        url: opts.url,
        method: opts.method ?? "GET",
        statusCode: res.status,
        statusMessage: String(res.status),
        headers: res.headers ?? {},
        // 退化成「装着一个 Uint8Array 的数组」—— isomorphic-git 明说不支持流式时
        // 可以这么办，for-await 会退回同步迭代。
        body: [new Uint8Array(res.arrayBuffer)],
      };
    },
  };
}
