import { describe, expect, it, vi } from "vitest";
import { collectBody, makeHttp } from "../src/http";

async function* chunks(...parts: Uint8Array[]) {
  for (const p of parts) yield p;
}

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
    const requestUrl = vi.fn().mockResolvedValue({
      status: 200, headers: {}, arrayBuffer: new Uint8Array([9, 9]).buffer,
    });
    const http = makeHttp(requestUrl as never);
    const res = await http.request({
      url: "https://h/r.git/info/refs", method: "POST",
      headers: { authorization: "Basic x" }, body: chunks(new Uint8Array([7])),
    } as never);

    const call = requestUrl.mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.throw).toBe(false);
    expect(new Uint8Array(call.body)).toEqual(new Uint8Array([7]));
    expect(res.statusCode).toBe(200);
    const got: number[] = [];
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) got.push(...c);
    expect(got).toEqual([9, 9]);
  });

  it("throw 必须传 false —— 否则 4xx 抛异常，拿不到状态码", async () => {
    // fake 照真实 requestUrl 的语义办事：throw 非 false 时 4xx 直接抛。
    // 不这么写的话本用例改不改 throw 都绿，名不副实。
    const requestUrl = vi.fn(async (p: { throw: boolean }) => {
      if (p.throw !== false) throw new Error("Request failed, status 401");
      return { status: 401, headers: {}, arrayBuffer: new ArrayBuffer(0) };
    });
    const http = makeHttp(requestUrl as never);
    const res = await http.request({ url: "u", method: "GET", headers: {} } as never);
    expect(res.statusCode).toBe(401);
  });
});
