import { describe, expect, it, vi } from "vitest";
import { collectBody, makeHttp } from "../src/http";

// eslint 的 require-await 会盯着「async 却不 await」的函数；用 Promise.resolve()
// 让它名副其实，同时保持异步迭代的语义（isomorphic-git 就是这么喂 body 的）。
async function* chunks(...parts: Uint8Array[]) {
  for (const p of parts) {
    await Promise.resolve();
    yield p;
  }
}

type FakeRes = { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer };

describe("collectBody", () => {
  it("把异步迭代的分片合并成一块", async () => {
    const out = await collectBody(chunks(new Uint8Array([1, 2]), new Uint8Array([3])));
    expect(Array.from(out!)).toEqual([1, 2, 3]);
  });

  it("没有 body 时返回 undefined", async () => {
    expect(await collectBody(undefined)).toBeUndefined();
  });
});

describe("makeHttp", () => {
  it("把请求转成 requestUrl 调用，响应包成可迭代 body", async () => {
    const requestUrl = vi.fn(
      (p: { method: string; throw: boolean; body?: ArrayBuffer }): Promise<FakeRes> =>
        Promise.resolve({
          // 回一个和请求方法有关的值，参数就不是摆设了（也就不会被判成未使用）。
          status: p.method === "POST" ? 200 : 500,
          headers: {},
          arrayBuffer: new Uint8Array([9, 9]).buffer,
        }),
    );
    const http = makeHttp(requestUrl);
    const res = await http.request({
      url: "https://h/r.git/info/refs", method: "POST",
      headers: { authorization: "Basic x" }, body: chunks(new Uint8Array([7])),
    });

    const call = requestUrl.mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.throw).toBe(false);
    expect(new Uint8Array(call.body!)).toEqual(new Uint8Array([7]));
    expect(res.statusCode).toBe(200);
    const got: number[] = [];
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) got.push(...c);
    expect(got).toEqual([9, 9]);
  });

  it("throw 必须传 false —— 否则 4xx 抛异常，拿不到状态码", async () => {
    // fake 照真实 requestUrl 的语义办事：throw 非 false 时 4xx 直接抛。
    // 不这么写的话本用例改不改 throw 都绿，名不副实。
    const requestUrl = vi.fn((p: { throw: boolean }): Promise<FakeRes> => {
      if (p.throw !== false) throw new Error("Request failed, status 401");
      return Promise.resolve({ status: 401, headers: {}, arrayBuffer: new ArrayBuffer(0) });
    });
    const http = makeHttp(requestUrl);
    const res = await http.request({ url: "u", method: "GET", headers: {} });
    expect(res.statusCode).toBe(401);
  });
});
