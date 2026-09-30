/**
 * Shared library mirror.
 *
 * Besides the personal inbox, the person may belong to one shared library. Its content stays on the
 * server, so here the vault holds a mirror of it: what the server adds appears, what the server removes
 * disappears, on every member's device. This runs after each inbox round with the same device token.
 *
 * Unlike the inbox this deletes files, so it is narrow about which ones:
 *   - only files under the library folder the server names (every path is checked to be inside it);
 *   - only files recorded in the shared ledger, i.e. files this plugin wrote;
 *   - only when the file still has the content it was written with. A file the user edited is never
 *     overwritten or deleted: it stops being tracked and stays as the user's own note.
 * Personal inbox files and the user's own notes are never touched.
 *
 * Protocol (JSON; Bearer device token):
 *   GET  {endpoint}/shared/manifest   If-None-Match: <etag>
 *        -> 304 | 200 {space: {slug, name}, root, etag, entries: [{id, can_delete, files: [{seq, path, size, sha256}]}]}
 *        -> 404: no library to mirror (not a member, or the feature is off): unchanged copies are removed
 *   GET  {endpoint}/shared/entries/{id}/files/{seq}  -> raw bytes (seq 0 is the page)
 *   POST {endpoint}/shared/deletions  {entry_ids}  -> {accepted: [id], rejected: [{id, reason}]}
 *
 * Deleting a mirrored page in Obsidian asks the server to delete that entry for everyone. Only the
 * contributor and the library's admins may; the server decides. Accepted: the page stays gone while the
 * server carries it out (put back after 30 minutes if it never does). Rejected: the page is put back.
 * Deleting only a file of an entry is not a request; it is put back. Many pages gone at once (the whole
 * folder deleted or moved) is taken as a mistake: nothing is reported and everything is put back.
 */
import type { RequestUrlFn } from "./http";
import {
  InboxError, VaultIO, call, dirname, ensureOk, isObject, parseJson, trimSlash, validatePath, webSha256, withSuffix,
} from "./inbox";

export type SharedFile = { seq: number; path: string; size: number; sha256: string };
export type SharedEntry = { id: number; can_delete: boolean; files: SharedFile[] };
export type SharedManifest = { space: { slug: string; name: string }; root: string; etag: string; entries: SharedEntry[] };

/** What the mirror needs on top of the inbox operations. */
export type MirrorIO = VaultIO & {
  remove(path: string): Promise<void>;
  list(dir: string): Promise<{ files: string[]; folders: string[] }>;
  rmdir(path: string): Promise<void>;
};

export type LedgerFile = { entry: number; seq: number; sha256: string };

/** Persisted between rounds. files: vault path -> what this plugin wrote there. */
export type SharedState = {
  slug: string; name: string; root: string;
  /** The library folder in the vault (target folder + root); every tracked file is inside it. */
  dir: string;
  etag: string;
  entries: number;
  files: Record<string, LedgerFile>;
  /** Entry id -> when the server accepted its deletion (ms). Its page is not put back meanwhile. */
  pendingDeletes: Record<string, number>;
};

export function emptySharedState(): SharedState {
  return { slug: "", name: "", root: "", dir: "", etag: "", entries: 0, files: {}, pendingDeletes: {} };
}

/** An accepted deletion the server has not carried out after this long is put back. */
export const PENDING_TTL_MS = 30 * 60_000;
/** More pages than this gone in one round is taken as a mistake, not as deletions. */
export const MASS_DELETE_LIMIT = 20;

const BAD = "服务器返回的共享库清单无法识别";

export function parseManifest(data: unknown): SharedManifest {
  if (!isObject(data) || !isObject(data.space) || typeof data.space.slug !== "string" || typeof data.space.name !== "string"
    || typeof data.root !== "string" || typeof data.etag !== "string" || !Array.isArray(data.entries)) {
    throw new InboxError("server", BAD);
  }
  const root = validatePath(data.root);
  const seen = new Set<string>();
  const entries: SharedEntry[] = [];
  for (const raw of data.entries as unknown[]) {
    if (!isObject(raw) || typeof raw.id !== "number" || !Number.isSafeInteger(raw.id) || !Array.isArray(raw.files)) {
      throw new InboxError("server", BAD);
    }
    const files: SharedFile[] = [];
    for (const f of raw.files as unknown[]) {
      if (!isObject(f) || typeof f.seq !== "number" || typeof f.path !== "string" || typeof f.size !== "number" || typeof f.sha256 !== "string") {
        throw new InboxError("server", BAD);
      }
      const path = validatePath(f.path);
      if (!path.startsWith(`${root}/`) || seen.has(path)) throw new InboxError("server", "unsafe_path");
      seen.add(path);
      files.push({ seq: f.seq, path, size: f.size, sha256: f.sha256 });
    }
    entries.push({ id: raw.id, can_delete: raw.can_delete === true, files });
  }
  return { space: { slug: data.space.slug, name: data.space.name }, root, etag: data.etag, entries };
}

export type SyncSharedDeps = {
  req: RequestUrlFn;
  endpoint: string;
  token: string;
  io: MirrorIO;
  /** The target folder inside the vault; empty = vault root. Already validated by the caller. */
  base: string;
  state: SharedState;
  persist: (state: SharedState) => Promise<void>;
  /** The user's switch. Off = remove the unchanged copies, the same as leaving the library. */
  enabled: boolean;
  sha256?: (data: Uint8Array) => Promise<string>;
  now?: () => number;
};

export type Retired = { name: string; removed: number; kept: number };

export type SyncSharedResult = {
  /** A library is being mirrored. */
  active: boolean;
  name: string;
  entries: number;
  written: number;
  /** Copies removed because the entry is gone on the server. */
  removed: number;
  /** Copies the server removed but the user had edited: kept as the user's notes (reported once). */
  kept: number;
  /** Entries that could not be written this round; retried next round. */
  failed: number;
  /** Set when the mirror of a library was just taken down (left it, switched off, switched library). */
  retired: Retired | null;
  /** Pages deleted here whose deletion the server accepted / refused (refused ones are put back). */
  accepted: number;
  rejected: number;
  /** Accepted deletions the server never carried out: put back. */
  expired: number;
  /** Pages put back because too many disappeared at once. */
  massRestored: number;
};

function join(base: string, path: string): string {
  return base ? `${base}/${path}` : path;
}

/** One round. Throws InboxError for auth, network and malformed-list problems; per-entry problems are counted and retried. */
export async function syncShared(d: SyncSharedDeps): Promise<SyncSharedResult> {
  const sha = d.sha256 ?? webSha256;
  const now = d.now ?? Date.now;
  const base = trimSlash(d.endpoint);
  const out: SyncSharedResult = {
    active: false, name: "", entries: 0, written: 0, removed: 0, kept: 0, failed: 0, retired: null,
    accepted: 0, rejected: 0, expired: 0, massRestored: 0,
  };
  const state = d.state;

  const inside = (path: string, dir: string) => Boolean(dir) && path.startsWith(`${dir}/`);

  const prune = async (from: string, stop: string) => {
    for (let dir = dirname(from); dir && dir !== stop && (!stop || dir.startsWith(`${stop}/`)); dir = dirname(dir)) {
      try {
        const l = await d.io.list(dir);
        if (l.files.length || l.folders.length) return;
        await d.io.rmdir(dir);
      } catch {
        return;
      }
    }
  };

  /** Remove a tracked copy if it is unchanged. true = removed, false = kept (edited), null = already gone. */
  const drop = async (path: string, led: LedgerFile, stop: string): Promise<boolean | null> => {
    if (!inside(path, state.dir)) return null;                    // never outside the library folder
    if (!(await d.io.exists(path))) return null;
    if ((await sha(await d.io.read(path))) !== led.sha256) return false;
    await d.io.remove(path);
    await prune(path, stop);
    return true;
  };

  const retire = async (): Promise<void> => {
    if (!state.dir && !Object.keys(state.files).length) return;
    const r: Retired = { name: state.name, removed: 0, kept: 0 };
    for (const [path, led] of Object.entries(state.files)) {
      const gone = await drop(path, led, d.base);
      if (gone === true) r.removed++;
      else if (gone === false) r.kept++;
    }
    out.retired = r;
    Object.assign(state, emptySharedState());
    await d.persist(state);
  };

  const download = async (entry: number, seq: number, want: string): Promise<Uint8Array> => {
    const res = await call(d.req, `${base}/shared/entries/${entry}/files/${seq}`, "GET", d.token);
    ensureOk(res, "下载");
    const data = new Uint8Array(res.arrayBuffer);
    if ((await sha(data)) !== want) throw new InboxError("server", "checksum_mismatch");
    return data;
  };

  const put = async (target: string, data: Uint8Array, want: string, overwrite: boolean): Promise<void> => {
    const dir = dirname(target);
    if (dir) await d.io.mkdirp(dir);
    if (overwrite) {
      await d.io.write(target, data);
    } else {
      const name = dir ? target.slice(dir.length + 1) : target;
      const tmp = dir ? `${dir}/.${name}.part` : `.${name}.part`;
      await d.io.write(tmp, data);
      await d.io.rename(tmp, target);
    }
    if ((await sha(await d.io.read(target))) !== want) throw new InboxError("server", "verify_failed");
  };

  const pending = (entry: number) => state.pendingDeletes[String(entry)] !== undefined;

  /** Pages of live entries that went missing here: report them, or take them as a mistake. */
  const settleDeletions = async (live: Set<number>): Promise<void> => {
    const expiredNow = new Set<number>();
    for (const [id, since] of Object.entries(state.pendingDeletes)) {
      if (!live.has(Number(id))) {
        delete state.pendingDeletes[id];                           // carried out
      } else if (now() - since > PENDING_TTL_MS) {
        delete state.pendingDeletes[id];
        expiredNow.add(Number(id));
        out.expired++;
      }
    }
    const pages = Object.entries(state.files).filter(([, l]) => l.seq === 0 && live.has(l.entry) && !pending(l.entry));
    const missing: number[] = [];
    for (const [path, l] of pages) {
      if (!expiredNow.has(l.entry) && !(await d.io.exists(path))) missing.push(l.entry);
    }
    if (!missing.length) return;
    if (missing.length > MASS_DELETE_LIMIT || (missing.length > 1 && missing.length === pages.length)) {
      out.massRestored = missing.length;
      return;
    }
    const res = await call(d.req, `${base}/shared/deletions`, "POST", d.token, { entry_ids: missing });
    ensureOk(res, "上报删除");
    const data = parseJson(res);
    if (!isObject(data) || !Array.isArray(data.accepted)) throw new InboxError("server", BAD);
    let accepted = 0;
    for (const id of data.accepted as unknown[]) {
      if (typeof id === "number" && missing.includes(id) && !pending(id)) {
        state.pendingDeletes[String(id)] = now();
        accepted++;
      }
    }
    out.accepted += accepted;
    out.rejected += missing.length - accepted;                     // put back below, like any missing copy
    await d.persist(state);
  };

  if (!d.enabled) {
    await retire();
    return out;
  }

  const res = await call(d.req, `${base}/shared/manifest`, "GET", d.token, undefined,
    state.etag ? { "If-None-Match": state.etag } : {});
  if (res.status === 404) {
    await retire();
    return out;
  }
  if (res.status === 304 && state.etag) {
    // Nothing changed on the server: only settle local deletions and put back tracked copies that went missing.
    await settleDeletions(new Set(Object.values(state.files).map((l) => l.entry)));
    for (const [path, led] of Object.entries(state.files)) {
      if (pending(led.entry) || await d.io.exists(path)) continue;
      try {
        await put(path, await download(led.entry, led.seq, led.sha256), led.sha256, false);
        out.written++;
      } catch (e) {
        if (e instanceof InboxError && (e.kind === "auth" || e.kind === "network")) throw e;
        out.failed++;
        state.etag = "";                                          // ask for the full list next round
      }
    }
    await d.persist(state);
    return { ...out, active: true, name: state.name, entries: state.entries };
  }
  ensureOk(res, "获取共享库清单");
  const m = parseManifest(parseJson(res));
  const dir = join(d.base, m.root);
  if (state.dir && (state.slug !== m.space.slug || state.dir !== dir)) await retire();
  Object.assign(state, { slug: m.space.slug, name: m.space.name, root: m.root, dir });

  await settleDeletions(new Set(m.entries.map((e) => e.id)));
  const placed = new Set<string>();
  const failedEntries = new Set<number>();
  for (const e of m.entries) {
    if (pending(e.id)) {
      for (const [p, l] of Object.entries(state.files)) if (l.entry === e.id) placed.add(p);
      continue;                                                    // deleted here, waiting for the server
    }
    try {
      // files first, the page last: a page never points at a file that is not there yet
      const ordered = [...e.files].sort((a, b) => Number(a.seq === 0) - Number(b.seq === 0) || a.seq - b.seq);
      for (const f of ordered) {
        const target = join(d.base, f.path);
        let done = false;
        for (const cand of [target, withSuffix(target, String(e.id))]) {
          const led = state.files[cand];
          const ours = led !== undefined && led.entry === e.id && led.seq === f.seq;
          const here = await d.io.exists(cand);
          if (ours && led.sha256 === f.sha256 && here) {
            done = true;                                          // trust the ledger: no need to read it again
          } else if (!here) {
            await put(cand, await download(e.id, f.seq, f.sha256), f.sha256, false);
            out.written++;
            done = true;
          } else {
            const local = await sha(await d.io.read(cand));
            if (local === f.sha256) {
              done = true;
            } else if (ours && local === led.sha256) {
              await put(cand, await download(e.id, f.seq, f.sha256), f.sha256, true);   // unchanged copy: update in place
              out.written++;
              done = true;
            } else if (ours) {
              delete state.files[cand];                           // the user edited it: it is theirs now
            }
          }
          if (done) {
            state.files[cand] = { entry: e.id, seq: f.seq, sha256: f.sha256 };
            placed.add(cand);
            break;
          }
        }
        if (!done) throw new InboxError("server", "name_conflict");
      }
    } catch (err) {
      if (err instanceof InboxError && (err.kind === "auth" || err.kind === "network")) {
        await d.persist(state);
        throw err;
      }
      failedEntries.add(e.id);
      out.failed++;
    }
  }

  for (const [path, led] of Object.entries(state.files)) {
    if (placed.has(path) || failedEntries.has(led.entry)) continue;
    const gone = await drop(path, led, state.dir);
    if (gone === true) out.removed++;
    else if (gone === false) out.kept++;
    delete state.files[path];
  }

  state.etag = out.failed ? "" : m.etag;
  state.entries = m.entries.length;
  await d.persist(state);
  return { ...out, active: true, name: state.name, entries: state.entries };
}
