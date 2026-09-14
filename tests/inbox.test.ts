import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RequestUrlFn } from "../src/http";
import {
  InboxError, InboxState, LEDGER_RETAIN_MS, VaultIO, claimDevice, emptyInboxState, parseItems, syncInbox, validatePath, withSuffix,
} from "../src/inbox";

const ENDPOINT = "https://inbox.example/api/v1";
const sha = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

class MemIO implements VaultIO {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  writes: string[] = [];
  corruptOnRead = new Set<string>();
  exists(p: string) { return Promise.resolve(this.files.has(p) || this.dirs.has(p)); }
  read(p: string) {
    const f = this.files.get(p);
    if (!f) return Promise.reject(new Error("missing"));
    return Promise.resolve(this.corruptOnRead.has(p) ? bytes("corrupted") : f);
  }
  write(p: string, d: Uint8Array) { this.writes.push(p); this.files.set(p, d); return Promise.resolve(); }
  rename(from: string, to: string) {
    const d = this.files.get(from);
    if (!d) return Promise.reject(new Error("missing"));
    this.files.delete(from);
    this.files.set(to, d);
    return Promise.resolve();
  }
  mkdirp(p: string) { this.dirs.add(p); return Promise.resolve(); }
}

type ServerFile = { seq: number; path: string; data: Uint8Array };
type ServerItem = { id: string; files: ServerFile[] };

function respond(status: number, body: unknown) {
  const b = body instanceof Uint8Array ? body : bytes(JSON.stringify(body));
  return { status, headers: {}, arrayBuffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
}

function server(items: ServerItem[], opt: { pageSize?: number; failAckTimes?: number; corrupt?: string } = {}) {
  const acked = new Set<string>();
  const events: string[] = [];
  let ackFailures = opt.failAckTimes ?? 0;
  const req: RequestUrlFn = (p) => {
    const url = new URL(p.url);
    const route = url.pathname.replace("/api/v1", "");
    events.push(`${p.method} ${route}`);
    if (p.headers["Authorization"] !== "Bearer tok") return Promise.resolve(respond(401, { error: "unauthorized" }));
    if (route === "/items") {
      const size = opt.pageSize ?? 50;
      const open = items.filter((i) => !acked.has(i.id));
      return Promise.resolve(respond(200, {
        items: open.slice(0, size).map((i) => ({
          id: i.id, created_at: "2026-09-14T00:00:00Z",
          files: i.files.map((f) => ({ seq: f.seq, path: f.path, size: f.data.length, sha256: sha(f.data) })),
        })),
        more: open.length > size,
      }));
    }
    const m = /^\/items\/([^/]+)\/files\/(\d+)$/.exec(route);
    if (m) {
      const f = items.find((i) => i.id === m[1])?.files.find((x) => x.seq === Number(m[2]));
      if (!f) return Promise.resolve(respond(404, {}));
      return Promise.resolve(respond(200, opt.corrupt === `${m[1]}/${m[2]}` ? bytes("tampered") : f.data));
    }
    if (route === "/ack") {
      if (ackFailures > 0) {
        ackFailures--;
        return Promise.reject(new Error("net::ERR_CONNECTION_RESET"));
      }
      const body = JSON.parse(new TextDecoder().decode(p.body)) as { ids: string[] };
      body.ids.forEach((i) => acked.add(i));
      return Promise.resolve(respond(200, { acked: body.ids }));
    }
    return Promise.resolve(respond(404, {}));
  };
  return { req, acked, events };
}

const ID1 = "aaaaaaaa-1111-4111-8111-111111111111";
const ID2 = "bbbbbbbb-2222-4222-8222-222222222222";
const note = (id: string, path = "notes/2026/9/a.md", text = "hello"): ServerItem =>
  ({ id, files: [{ seq: 0, path, data: bytes(text) }, { seq: 1, path: "files/pic-0123abcd.png", data: bytes("PNG" + id) }] });

function deps(s: ReturnType<typeof server>, io: MemIO, state: InboxState, extra: Partial<Parameters<typeof syncInbox>[0]> = {}) {
  return {
    req: s.req, endpoint: ENDPOINT, token: "tok", io, root: "", state,
    persist: () => { s.events.push("persist"); return Promise.resolve(); },
    ...extra,
  };
}

describe("validatePath", () => {
  it("accepts ordinary relative paths", () => {
    expect(validatePath("notes/2026/9/a note.md")).toBe("notes/2026/9/a note.md");
    expect(validatePath("笔记/图片-01.png")).toBe("笔记/图片-01.png");
  });
  it("rejects anything that could escape, hide or break the file system", () => {
    const unsafe = ["", "/abs.md", "a\\b.md", "../x.md", "a/../b.md", "a/./b.md", ".hidden/x.md", "a/.part", "a/b.", "a /b", "a<b.md",
      "c:x.md", "a//b.md", "a/b ", "tab" + String.fromCharCode(9) + "x.md"];
    for (const p of unsafe) {
      expect(() => validatePath(p), p).toThrow(InboxError);
    }
  });
});

describe("withSuffix", () => {
  it("puts the suffix before the extension", () => {
    expect(withSuffix("notes/a.md", "aaaaaaaa")).toBe("notes/a-aaaaaaaa.md");
    expect(withSuffix("notes/README", "x")).toBe("notes/README-x");
    expect(withSuffix("notes.v2/file", "x")).toBe("notes.v2/file-x");
  });
});

describe("claimDevice", () => {
  it("exchanges a code for a token without sending any token", async () => {
    const req: RequestUrlFn = (p) => {
      expect(p.url).toBe(`${ENDPOINT}/claim`);
      expect(p.headers["Authorization"]).toBeUndefined();
      expect(JSON.parse(new TextDecoder().decode(p.body))).toEqual({ code: "C", label: "laptop" });
      return Promise.resolve(respond(200, { token: "tok", device_id: 7 }));
    };
    await expect(claimDevice(req, ENDPOINT + "/", "C", "laptop")).resolves.toEqual({ token: "tok", deviceId: "7" });
  });
  it("explains used or expired codes", async () => {
    const req: RequestUrlFn = () => Promise.resolve(respond(410, { error: "gone" }));
    await expect(claimDevice(req, ENDPOINT, "C", "laptop")).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("parseItems", () => {
  it("rejects malformed lists instead of guessing", () => {
    expect(() => parseItems({ items: [{ id: 1, files: [] }] })).toThrow(InboxError);
    expect(() => parseItems({ nope: true })).toThrow(InboxError);
  });
});

describe("syncInbox", () => {
  it("writes files, verifies them, records before acknowledging, and acknowledges", async () => {
    const s = server([note(ID1)]);
    const io = new MemIO();
    const state = emptyInboxState();
    const r = await syncInbox(deps(s, io, state, { now: () => 1000 }));
    expect(r).toEqual({ written: 2, acked: 1, failed: 0 });
    expect(new TextDecoder().decode(io.files.get("notes/2026/9/a.md"))).toBe("hello");
    expect(io.files.has("files/pic-0123abcd.png")).toBe(true);
    expect([...io.files.keys()].some((k) => k.includes(".part"))).toBe(false);
    expect(io.writes.indexOf("files/.pic-0123abcd.png.part")).toBeLessThan(io.writes.indexOf("notes/2026/9/.a.md.part"));
    expect(state.ledger[ID1]).toBe(1000);
    expect(s.acked.has(ID1)).toBe(true);
    expect(s.events.indexOf("persist")).toBeGreaterThan(-1);
    expect(s.events.indexOf("persist")).toBeLessThan(s.events.indexOf("POST /ack"));
  });

  it("writes into the target folder when one is set", async () => {
    const s = server([note(ID1)]);
    const io = new MemIO();
    await syncInbox(deps(s, io, emptyInboxState(), { root: "inbox" }));
    expect(io.files.has("inbox/notes/2026/9/a.md")).toBe(true);
  });

  it("does not acknowledge an item whose download fails its checksum, and reports it", async () => {
    const s = server([note(ID1)], { corrupt: `${ID1}/1` });
    const io = new MemIO();
    const state = emptyInboxState();
    const r = await syncInbox(deps(s, io, state));
    expect(r.failed).toBe(1);
    expect(s.acked.has(ID1)).toBe(false);
    expect(state.ledger[ID1]).toBeUndefined();
    expect(io.files.has("notes/2026/9/a.md")).toBe(false);
  });

  it("does not acknowledge when the file on disk does not read back correctly", async () => {
    const s = server([note(ID1)]);
    const io = new MemIO();
    io.corruptOnRead.add("notes/2026/9/a.md");
    const r = await syncInbox(deps(s, io, emptyInboxState()));
    expect(r.failed).toBe(1);
    expect(s.acked.has(ID1)).toBe(false);
  });

  it("keeps a lost acknowledgement and resends it without writing again", async () => {
    const s = server([note(ID1)], { failAckTimes: 1 });
    const io = new MemIO();
    const state = emptyInboxState();
    await expect(syncInbox(deps(s, io, state))).rejects.toMatchObject({ kind: "network" });
    expect(state.pendingAcks).toEqual([ID1]);
    expect(state.ledger[ID1]).toBeDefined();
    const writes = io.writes.length;
    const r = await syncInbox(deps(s, io, state));
    expect(r.acked).toBe(1);
    expect(s.acked.has(ID1)).toBe(true);
    expect(io.writes.length).toBe(writes);
    expect(state.pendingAcks).toEqual([]);
  });

  it("never recreates a delivered file that the user deleted", async () => {
    const s = server([note(ID1)]);
    const io = new MemIO();
    const state = emptyInboxState();
    await syncInbox(deps(s, io, state));
    io.files.delete("notes/2026/9/a.md");
    s.acked.delete(ID1);                                   // e.g. the acknowledgement never reached the server
    await syncInbox(deps(s, io, state));
    expect(io.files.has("notes/2026/9/a.md")).toBe(false);
    expect(s.acked.has(ID1)).toBe(true);
  });

  it("never overwrites a different file already at the target path", async () => {
    const s = server([note(ID1)]);
    const io = new MemIO();
    io.files.set("notes/2026/9/a.md", bytes("my own note"));
    await syncInbox(deps(s, io, emptyInboxState()));
    expect(new TextDecoder().decode(io.files.get("notes/2026/9/a.md"))).toBe("my own note");
    expect(new TextDecoder().decode(io.files.get("notes/2026/9/a-aaaaaaaa.md"))).toBe("hello");
  });

  it("treats an identical existing file as already delivered", async () => {
    const s = server([note(ID1)]);
    const io = new MemIO();
    io.files.set("notes/2026/9/a.md", bytes("hello"));
    await syncInbox(deps(s, io, emptyInboxState()));
    expect(io.writes).not.toContain("notes/2026/9/.a.md.part");
    expect(s.acked.has(ID1)).toBe(true);
  });

  it("refuses unsafe paths from the server without writing anything", async () => {
    const s = server([note(ID1, "../outside.md")]);
    const io = new MemIO();
    const r = await syncInbox(deps(s, io, emptyInboxState()));
    expect(r.failed).toBe(1);
    expect([...io.files.keys()].some((k) => k.includes("outside"))).toBe(false);
  });

  it("pages through all items", async () => {
    const s = server([note(ID1), note(ID2, "notes/2026/9/b.md")], { pageSize: 1 });
    const io = new MemIO();
    const r = await syncInbox(deps(s, io, emptyInboxState()));
    expect(r.acked).toBe(2);
    expect(io.files.has("notes/2026/9/b.md")).toBe(true);
  });

  it("reports an unlinked device as an auth problem", async () => {
    const s = server([note(ID1)]);
    await expect(syncInbox({ ...deps(s, new MemIO(), emptyInboxState()), token: "revoked" })).rejects.toMatchObject({ kind: "auth" });
  });

  it("reports an unreachable server as a network problem", async () => {
    const req: RequestUrlFn = () => Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED"));
    await expect(syncInbox({ ...deps(server([]), new MemIO(), emptyInboxState()), req })).rejects.toMatchObject({ kind: "network" });
  });

  it("forgets ledger entries after the server can no longer resend them", async () => {
    const state: InboxState = { ledger: { old: 0, recent: LEDGER_RETAIN_MS }, pendingAcks: [] };
    await syncInbox(deps(server([]), new MemIO(), state, { now: () => LEDGER_RETAIN_MS + 10 }));
    expect(Object.keys(state.ledger)).toEqual(["recent"]);
  });
});
