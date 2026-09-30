import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RequestUrlFn } from "../src/http";
import { InboxError } from "../src/inbox";
import { MirrorIO, SharedState, emptySharedState, parseManifest, syncShared } from "../src/shared";

const ENDPOINT = "https://inbox.example/api/v1";
const sha = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (d: Uint8Array | undefined) => (d ? new TextDecoder().decode(d) : undefined);

class MemIO implements MirrorIO {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  removed: string[] = [];
  exists(p: string) { return Promise.resolve(this.files.has(p) || this.dirs.has(p)); }
  read(p: string) {
    const f = this.files.get(p);
    return f ? Promise.resolve(f) : Promise.reject(new Error("missing"));
  }
  write(p: string, d: Uint8Array) { this.files.set(p, d); return Promise.resolve(); }
  rename(from: string, to: string) {
    const d = this.files.get(from);
    if (!d) return Promise.reject(new Error("missing"));
    if (this.files.has(to)) return Promise.reject(new Error("exists"));
    this.files.delete(from);
    this.files.set(to, d);
    return Promise.resolve();
  }
  mkdirp(p: string) {
    let cur = "";
    for (const s of p.split("/")) {
      cur = cur ? `${cur}/${s}` : s;
      this.dirs.add(cur);
    }
    return Promise.resolve();
  }
  remove(p: string) {
    if (!this.files.delete(p)) return Promise.reject(new Error("missing"));
    this.removed.push(p);
    return Promise.resolve();
  }
  list(dir: string) {
    const under = (p: string) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/");
    return Promise.resolve({ files: [...this.files.keys()].filter(under), folders: [...this.dirs].filter(under) });
  }
  rmdir(p: string) {
    const busy = [...this.files.keys(), ...this.dirs].some((x) => x.startsWith(`${p}/`));
    if (busy) return Promise.reject(new Error("not empty"));
    this.dirs.delete(p);
    return Promise.resolve();
  }
  put(p: string, s: string) {
    this.files.set(p, bytes(s));
    const i = p.lastIndexOf("/");
    if (i > 0) void this.mkdirp(p.slice(0, i));
  }
}

type SFile = { seq: number; path: string; data: Uint8Array };
type SEntry = { id: number; can_delete?: boolean; files: SFile[] };

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const b = body instanceof Uint8Array ? body : bytes(body === "" ? "" : JSON.stringify(body));
  return { status, headers, arrayBuffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
}

/** A fake library server. Mutate `entries` / `root` / `member` between rounds. */
function server(init: SEntry[], opt: { root?: string; slug?: string } = {}) {
  const s = {
    entries: init, root: opt.root ?? "Shared/Pilot", slug: opt.slug ?? "pilot", name: "Pilot", member: true,
    corrupt: "", events: [] as string[], deletions: [] as number[][],
    etag(): string {
      return `"${sha(JSON.stringify([s.slug, s.root, s.entries.map((e) => [e.id, e.can_delete, e.files.map((f) => [f.path, sha(f.data)])])]))}"`;
    },
  };
  const req: RequestUrlFn = (p) => {
    const route = new URL(p.url).pathname.replace("/api/v1", "");
    s.events.push(`${p.method} ${route}`);
    if (p.headers["Authorization"] !== "Bearer tok") return Promise.resolve(respond(401, {}));
    if (!s.member) return Promise.resolve(respond(404, { error: "not found" }));
    if (route === "/shared/manifest") {
      const etag = s.etag();
      if (p.headers["If-None-Match"] === etag) return Promise.resolve(respond(304, ""));
      return Promise.resolve(respond(200, {
        space: { slug: s.slug, name: s.name }, root: s.root, etag,
        entries: s.entries.map((e) => ({
          id: e.id, can_delete: e.can_delete ?? false,
          files: e.files.map((f) => ({ seq: f.seq, path: f.path, size: f.data.length, sha256: sha(f.data) })),
        })),
      }, { etag }));
    }
    if (route === "/shared/deletions" && p.method === "POST") {
      const ids = (JSON.parse(new TextDecoder().decode(p.body)) as { entry_ids: number[] }).entry_ids;
      s.deletions.push(ids);
      const accepted: number[] = [];
      const rejected: { id: number; reason: string }[] = [];
      for (const id of ids) {
        const e = s.entries.find((x) => x.id === id);
        if (!e) rejected.push({ id, reason: "not_found" });
        else if (!e.can_delete) rejected.push({ id, reason: "not_allowed" });
        else accepted.push(id);
      }
      return Promise.resolve(respond(200, { accepted, rejected }));
    }
    const m = /^\/shared\/entries\/(\d+)\/files\/(\d+)$/.exec(route);
    if (m) {
      const f = s.entries.find((e) => e.id === Number(m[1]))?.files.find((x) => x.seq === Number(m[2]));
      if (!f) return Promise.resolve(respond(404, {}));
      return Promise.resolve(respond(200, s.corrupt === `${m[1]}/${m[2]}` ? bytes("tampered") : f.data));
    }
    return Promise.resolve(respond(404, {}));
  };
  return { s, req };
}

function entry(id: number, title: string, withFile = false): SEntry {
  const files: SFile[] = [{ seq: 0, path: `Shared/Pilot/2026/10/${title}-${id}.md`, data: bytes(`page ${id}`) }];
  if (withFile) files.push({ seq: 1, path: `Shared/Pilot/files/${title}-${id}.pdf`, data: bytes(`pdf ${id}`) });
  return { id, files };
}

async function round(req: RequestUrlFn, io: MemIO, state: SharedState, extra: { base?: string; enabled?: boolean; now?: number } = {}) {
  const saved: SharedState[] = [];
  const r = await syncShared({
    req, endpoint: ENDPOINT, token: "tok", io, base: extra.base ?? "", state, enabled: extra.enabled ?? true,
    now: () => extra.now ?? 1_000_000,
    persist: (st) => { saved.push(JSON.parse(JSON.stringify(st)) as SharedState); return Promise.resolve(); },
  });
  return { r, saved };
}

describe("parseManifest", () => {
  it("rejects paths outside the library folder and unsafe roots", () => {
    const ok = { space: { slug: "p", name: "P" }, root: "Shared/P", etag: "\"e\"", entries: [{ id: 1, can_delete: false, files: [{ seq: 0, path: "Shared/P/a-1.md", size: 1, sha256: "x" }] }] };
    expect(parseManifest(ok).entries[0].files[0].path).toBe("Shared/P/a-1.md");
    const bad = (patch: Record<string, unknown>) => () => parseManifest({ ...ok, ...patch });
    expect(bad({ root: "" })).toThrow(InboxError);
    expect(bad({ root: "../x" })).toThrow(InboxError);
    expect(bad({ root: ".obsidian" })).toThrow(InboxError);
    expect(bad({ entries: [{ id: 1, can_delete: false, files: [{ seq: 0, path: "Notes/a.md", size: 1, sha256: "x" }] }] })).toThrow(InboxError);
    expect(bad({ entries: [{ id: 1, can_delete: false, files: [{ seq: 0, path: "Shared/P/../../a.md", size: 1, sha256: "x" }] }] })).toThrow(InboxError);
    expect(bad({ entries: [{ id: "1", can_delete: false, files: [] }] })).toThrow(InboxError);
    expect(bad({ entries: [{ id: 1, can_delete: false, files: [{ seq: 0, path: "Shared/P/a-1.md", size: 1, sha256: "x" }, { seq: 1, path: "Shared/P/a-1.md", size: 1, sha256: "y" }] }] })).toThrow(InboxError);
  });
});

describe("syncShared", () => {
  it("mirrors every entry into the library folder, then asks with the etag and downloads nothing", async () => {
    const { s, req } = server([entry(1, "a", true), entry(2, "b")]);
    const io = new MemIO();
    const state = emptySharedState();
    const { r } = await round(req, io, state, { base: "Inbox" });
    expect(r).toMatchObject({ active: true, name: "Pilot", entries: 2, written: 3 });
    expect(text(io.files.get("Inbox/Shared/Pilot/2026/10/a-1.md"))).toBe("page 1");
    expect(text(io.files.get("Inbox/Shared/Pilot/files/a-1.pdf"))).toBe("pdf 1");
    expect(Object.keys(state.files).sort()).toEqual(["Inbox/Shared/Pilot/2026/10/a-1.md", "Inbox/Shared/Pilot/2026/10/b-2.md", "Inbox/Shared/Pilot/files/a-1.pdf"]);
    expect(state.etag).toBe(s.etag());
    s.events.length = 0;
    const again = await round(req, io, state, { base: "Inbox" });
    expect(again.r).toMatchObject({ active: true, entries: 2, written: 0 });
    expect(s.events).toEqual(["GET /shared/manifest"]);
  });

  it("removes the local copy when the entry is deleted on the server, and prunes empty folders", async () => {
    const { s, req } = server([entry(1, "a", true), entry(2, "b")]);
    const io = new MemIO();
    io.put("My note.md", "mine");
    io.put("Shared/Pilot/2026/10/my own note.md", "also mine");      // a note the user put inside the library folder
    const state = emptySharedState();
    await round(req, io, state);
    s.entries = [entry(2, "b")];
    const { r } = await round(req, io, state);
    expect(r).toMatchObject({ removed: 2, kept: 0, entries: 1 });
    expect(io.files.has("Shared/Pilot/2026/10/a-1.md")).toBe(false);
    expect(io.files.has("Shared/Pilot/files/a-1.pdf")).toBe(false);
    expect(io.dirs.has("Shared/Pilot/files")).toBe(false);            // emptied folder goes too
    expect(text(io.files.get("My note.md"))).toBe("mine");
    expect(text(io.files.get("Shared/Pilot/2026/10/my own note.md"))).toBe("also mine");
    expect(io.removed.sort()).toEqual(["Shared/Pilot/2026/10/a-1.md", "Shared/Pilot/files/a-1.pdf"]);
  });

  it("keeps a file the user edited when the server deletes it, and stops tracking it", async () => {
    const { s, req } = server([entry(1, "a"), entry(2, "b")]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    io.put("Shared/Pilot/2026/10/a-1.md", "page 1 with my notes");
    s.entries = [entry(2, "b")];
    const { r } = await round(req, io, state);
    expect(r).toMatchObject({ removed: 0, kept: 1 });
    expect(text(io.files.get("Shared/Pilot/2026/10/a-1.md"))).toBe("page 1 with my notes");
    expect(state.files["Shared/Pilot/2026/10/a-1.md"]).toBeUndefined();
    expect((await round(req, io, state)).r.kept).toBe(0);              // told once, not every round
  });

  it("updates an unchanged copy in place, but never overwrites a copy the user edited", async () => {
    const { s, req } = server([entry(1, "a"), entry(2, "b")]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    io.put("Shared/Pilot/2026/10/b-2.md", "page 2 with my notes");
    s.entries = [
      { id: 1, files: [{ seq: 0, path: "Shared/Pilot/2026/10/a-1.md", data: bytes("page 1 v2") }] },
      { id: 2, files: [{ seq: 0, path: "Shared/Pilot/2026/10/b-2.md", data: bytes("page 2 v2") }] },
    ];
    const { r } = await round(req, io, state);
    expect(text(io.files.get("Shared/Pilot/2026/10/a-1.md"))).toBe("page 1 v2");
    expect(text(io.files.get("Shared/Pilot/2026/10/b-2.md"))).toBe("page 2 with my notes");
    expect(text(io.files.get("Shared/Pilot/2026/10/b-2-2.md"))).toBe("page 2 v2");
    expect(state.files["Shared/Pilot/2026/10/b-2.md"]).toBeUndefined();
    expect(state.files["Shared/Pilot/2026/10/b-2-2.md"]).toMatchObject({ entry: 2, seq: 0 });
    expect(r.written).toBe(2);
    expect((await round(req, io, state)).r.written).toBe(0);          // settles: no rewrite every round
  });

  it("never overwrites a file it did not write", async () => {
    const { req } = server([entry(1, "a")]);
    const io = new MemIO();
    io.put("Shared/Pilot/2026/10/a-1.md", "someone else's file");
    const state = emptySharedState();
    await round(req, io, state);
    expect(text(io.files.get("Shared/Pilot/2026/10/a-1.md"))).toBe("someone else's file");
    expect(text(io.files.get("Shared/Pilot/2026/10/a-1-1.md"))).toBe("page 1");
  });

  it("restores a mirrored file the user deleted, even when nothing changed on the server", async () => {
    const { s, req } = server([entry(1, "a", true)]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    await io.remove("Shared/Pilot/files/a-1.pdf");
    s.events.length = 0;
    await round(req, io, state);
    expect(text(io.files.get("Shared/Pilot/files/a-1.pdf"))).toBe("pdf 1");
    expect(s.events).toEqual(["GET /shared/manifest", "GET /shared/entries/1/files/1"]);
  });

  it("does not record a download that fails its checksum, and asks for the full list again next round", async () => {
    const { s, req } = server([entry(1, "a", true), entry(2, "b")]);
    s.corrupt = "1/1";
    const io = new MemIO();
    const state = emptySharedState();
    const { r } = await round(req, io, state);
    expect(r.failed).toBe(1);
    expect(io.files.has("Shared/Pilot/files/a-1.pdf")).toBe(false);
    expect(io.files.has("Shared/Pilot/2026/10/a-1.md")).toBe(false);   // the page never points at a missing file
    expect(text(io.files.get("Shared/Pilot/2026/10/b-2.md"))).toBe("page 2");
    expect(state.etag).toBe("");
    s.corrupt = "";
    expect((await round(req, io, state)).r).toMatchObject({ failed: 0, written: 2 });
  });

  it("refuses an unsafe list without touching anything", async () => {
    const { s, req } = server([entry(1, "a")]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    s.entries = [{ id: 3, files: [{ seq: 0, path: "My note.md", data: bytes("x") }] }];
    io.put("My note.md", "mine");
    await expect(round(req, io, state)).rejects.toThrow(InboxError);
    expect(text(io.files.get("My note.md"))).toBe("mine");
    expect(text(io.files.get("Shared/Pilot/2026/10/a-1.md"))).toBe("page 1");
  });

  it("removes its unchanged copies when the person is no longer a member, and keeps edited ones", async () => {
    const { s, req } = server([entry(1, "a", true), entry(2, "b")]);
    const io = new MemIO();
    io.put("Notes/mine.md", "mine");
    const state = emptySharedState();
    await round(req, io, state);
    io.put("Shared/Pilot/2026/10/b-2.md", "page 2 with my notes");
    s.member = false;
    const { r } = await round(req, io, state);
    expect(r).toMatchObject({ active: false, retired: { name: "Pilot", removed: 2, kept: 1 } });
    expect([...io.files.keys()].sort()).toEqual(["Notes/mine.md", "Shared/Pilot/2026/10/b-2.md"]);
    expect(state).toEqual(emptySharedState());
    expect((await round(req, io, state)).r.retired).toBeNull();         // said once
  });

  it("does the same when sync is switched off, without asking the server", async () => {
    const { s, req } = server([entry(1, "a")]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    s.events.length = 0;
    const { r } = await round(req, io, state, { enabled: false });
    expect(r).toMatchObject({ active: false, retired: { removed: 1, kept: 0 } });
    expect(s.events).toEqual([]);
    expect(io.files.size).toBe(0);
  });

  it("switches libraries: the old copies go, the new library comes in", async () => {
    const { s, req } = server([entry(1, "a")]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    s.slug = "other"; s.root = "Shared/Other"; s.name = "Other";
    s.entries = [{ id: 7, files: [{ seq: 0, path: "Shared/Other/x-7.md", data: bytes("page 7") }] }];
    const { r } = await round(req, io, state);
    expect(r).toMatchObject({ active: true, name: "Other", retired: { name: "Pilot", removed: 1 } });
    expect([...io.files.keys()]).toEqual(["Shared/Other/x-7.md"]);
  });

  it("does nothing for a person who is in no library", async () => {
    const { s, req } = server([]);
    s.member = false;
    const io = new MemIO();
    const { r } = await round(req, io, emptySharedState());
    expect(r).toMatchObject({ active: false, retired: null, written: 0 });
    expect(io.files.size).toBe(0);
  });

  it("never deletes outside the library folder, even if the ledger says so", async () => {
    const { s, req } = server([entry(1, "a")]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    io.put("My note.md", "mine");
    state.files["My note.md"] = { entry: 1, seq: 0, sha256: sha("mine") };       // a tampered or stale ledger
    s.member = false;
    await round(req, io, state);
    expect(text(io.files.get("My note.md"))).toBe("mine");
    expect(io.files.has("Shared/Pilot/2026/10/a-1.md")).toBe(false);
  });

  it("keeps the old copy of an entry whose update failed", async () => {
    const { s, req } = server([entry(1, "a")]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    s.entries = [{ id: 1, files: [{ seq: 0, path: "Shared/Pilot/2026/10/a-renamed-1.md", data: bytes("page 1 v2") }] }];
    s.corrupt = "1/0";
    const { r } = await round(req, io, state);
    expect(r).toMatchObject({ failed: 1, removed: 0 });
    expect(text(io.files.get("Shared/Pilot/2026/10/a-1.md"))).toBe("page 1");
    s.corrupt = "";
    expect((await round(req, io, state)).r).toMatchObject({ failed: 0, written: 1, removed: 1 });
    expect([...io.files.keys()]).toEqual(["Shared/Pilot/2026/10/a-renamed-1.md"]);
  });

  it("reports an unlinked device as an auth problem", async () => {
    const { req } = server([]);
    await expect(syncShared({
      req, endpoint: ENDPOINT, token: "bad", io: new MemIO(), base: "", state: emptySharedState(), enabled: true, persist: () => Promise.resolve(),
    })).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("syncShared: deleting in Obsidian", () => {
  const PAGE1 = "Shared/Pilot/2026/10/a-1.md";
  const own = (e: SEntry): SEntry => ({ ...e, can_delete: true });

  it("reports a deleted page, does not bring it back, and removes the rest once the server has deleted it", async () => {
    const { s, req } = server([own(entry(1, "a", true)), entry(2, "b")]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    await io.remove(PAGE1);
    const { r } = await round(req, io, state);                              // nothing changed on the server: 304
    expect(r).toMatchObject({ accepted: 1, rejected: 0, written: 0 });
    expect(s.deletions).toEqual([[1]]);
    expect(io.files.has(PAGE1)).toBe(false);
    expect(Object.keys(state.pendingDeletes)).toEqual(["1"]);
    s.entries = [...s.entries, entry(3, "c")];                               // the list changes for another reason
    expect((await round(req, io, state)).r).toMatchObject({ written: 1, accepted: 0 });
    expect(io.files.has(PAGE1)).toBe(false);                                 // still waiting: not put back
    s.entries = [entry(2, "b"), entry(3, "c")];                              // the server carries it out
    const after = await round(req, io, state);
    expect(after.r).toMatchObject({ removed: 1, accepted: 0 });
    expect(io.files.has("Shared/Pilot/files/a-1.pdf")).toBe(false);
    expect(state.pendingDeletes).toEqual({});
    expect(s.deletions).toHaveLength(1);                                     // reported once
  });

  it("puts back a page the person may not delete, and says so", async () => {
    const { s, req } = server([entry(1, "a"), entry(2, "b")]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    await io.remove(PAGE1);
    const { r } = await round(req, io, state);
    expect(r).toMatchObject({ accepted: 0, rejected: 1, written: 1 });
    expect(text(io.files.get(PAGE1))).toBe("page 1");
    expect(state.pendingDeletes).toEqual({});
    expect(s.deletions).toEqual([[1]]);
  });

  it("brings an accepted deletion back if the server has not carried it out after 30 minutes", async () => {
    const { s, req } = server([own(entry(1, "a")), entry(2, "b")]);
    const io = new MemIO();
    const state = emptySharedState();
    const t0 = 1_000_000;
    await round(req, io, state, { now: t0 });
    await io.remove(PAGE1);
    expect((await round(req, io, state, { now: t0 })).r.accepted).toBe(1);
    expect((await round(req, io, state, { now: t0 + 10 * 60_000 })).r).toMatchObject({ written: 0, expired: 0, accepted: 0 });
    expect(io.files.has(PAGE1)).toBe(false);
    const late = await round(req, io, state, { now: t0 + 31 * 60_000 });
    expect(late.r).toMatchObject({ expired: 1, written: 1, accepted: 0 });
    expect(text(io.files.get(PAGE1))).toBe("page 1");
    expect(s.deletions).toHaveLength(1);
  });

  it("does not treat a deleted file of an entry as a request to delete the entry", async () => {
    const { s, req } = server([own(entry(1, "a", true))]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    await io.remove("Shared/Pilot/files/a-1.pdf");
    await round(req, io, state);
    expect(s.deletions).toEqual([]);
    expect(text(io.files.get("Shared/Pilot/files/a-1.pdf"))).toBe("pdf 1");
  });

  it("takes the whole library folder disappearing as a mistake: reports nothing, puts everything back", async () => {
    const { s, req } = server([own(entry(1, "a")), own(entry(2, "b")), own(entry(3, "c"))]);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    for (const p of [...io.files.keys()]) await io.remove(p);
    const { r } = await round(req, io, state);
    expect(r).toMatchObject({ massRestored: 3, accepted: 0, written: 3 });
    expect(s.deletions).toEqual([]);
    expect(io.files.size).toBe(3);
  });

  it("also for many pages at once, even if some remain", async () => {
    const many = Array.from({ length: 25 }, (_, i) => own(entry(i + 1, `t${i + 1}`)));
    const { s, req } = server(many);
    const io = new MemIO();
    const state = emptySharedState();
    await round(req, io, state);
    for (let i = 1; i <= 21; i++) await io.remove(`Shared/Pilot/2026/10/t${i}-${i}.md`);
    const { r } = await round(req, io, state);
    expect(r.massRestored).toBe(21);
    expect(s.deletions).toEqual([]);
  });
});
