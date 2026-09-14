/**
 * Inbox mode.
 *
 * The server keeps a queue of items for the person this device belongs to. Each round the plugin lists
 * new items, downloads every file, checks its SHA-256, writes it into the vault through a temporary
 * file and a rename, reads it back to verify it, records the item in a local ledger, and only then
 * acknowledges it. The server deletes acknowledged items after a grace period.
 *
 * Because the server copy goes away after delivery, the local copy is the only one left. So, unlike
 * mirror mode, inbox mode never deletes a file and never overwrites a file it did not write itself:
 * if a different file already sits at the target path, the new one gets a suffix instead.
 *
 * Protocol (JSON; Bearer device token on everything except claim):
 *   POST {endpoint}/claim                {code, label}                -> {token, device_id}
 *   GET  {endpoint}/items?limit=N                                     -> {items: [{id, created_at, files: [{seq, path, size, sha256}]}], more}
 *   GET  {endpoint}/items/{id}/files/{seq}                            -> raw bytes
 *   POST {endpoint}/ack                  {ids, failed: [{id, code}]}  -> {acked}
 *   POST {endpoint}/device/revoke                                     -> 204
 * Paths come from the server and are validated here before anything touches the vault.
 */
import type { RequestUrlFn } from "./http";

export type InboxFile = { seq: number; path: string; size: number; sha256: string };
export type InboxItem = { id: string; created_at: string; files: InboxFile[] };

/** The vault operations inbox mode needs. Implemented with the Obsidian vault adapter in main.ts. */
export type VaultIO = {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
};

/** Persisted between rounds. ledger: item id -> time it was written (ms). */
export type InboxState = { ledger: Record<string, number>; pendingAcks: string[] };

export const PAGE_LIMIT = 50;
export const MAX_PAGES = 20;
/** The server never keeps an item longer than 30 days, so older ledger entries can go. */
export const LEDGER_RETAIN_MS = 40 * 24 * 3600_000;

export function emptyInboxState(): InboxState {
  return { ledger: {}, pendingAcks: [] };
}

export class InboxError extends Error {
  constructor(readonly kind: "auth" | "network" | "server", message: string) {
    super(message);
    this.name = "InboxError";
  }
}

const RESERVED = /[<>:"|?*]/;

function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 32 || s.charCodeAt(i) === 127) return true;
  }
  return false;
}

/** A server-provided relative path, made safe for the vault. Throws on anything that could escape or hide. */
export function validatePath(path: string): string {
  if (typeof path !== "string" || !path || path.length > 400 || path.startsWith("/") || path.includes("\\")
    || RESERVED.test(path) || hasControlCharacter(path)) {
    throw new InboxError("server", "unsafe_path");
  }
  const segments = path.split("/");
  for (const s of segments) {
    if (!s || s === "." || s === ".." || s.startsWith(".") || s.endsWith(" ") || s.endsWith(".") || s.length > 200) {
      throw new InboxError("server", "unsafe_path");
    }
  }
  return segments.join("/");
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export async function webSha256(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", toArrayBuffer(data)));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

type Response = { status: number; arrayBuffer: ArrayBuffer };

async function call(req: RequestUrlFn, url: string, method: string, token: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await req({
      url, method, headers, throw: false,
      body: body === undefined ? undefined : toArrayBuffer(new TextEncoder().encode(JSON.stringify(body))),
    });
  } catch {
    throw new InboxError("network", "Cannot reach the server. Check your network connection.");
  }
}

function ensureOk(res: Response, what: string): void {
  if (res.status === 401) {
    throw new InboxError("auth", "This device is no longer linked. Get a new setup code and paste it in the settings.");
  }
  if (res.status >= 400) throw new InboxError("server", `${what} failed (HTTP ${res.status})`);
}

function parseJson(res: Response): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(res.arrayBuffer)) as unknown;
  } catch {
    throw new InboxError("server", `Unexpected response from the server (HTTP ${res.status})`);
  }
}

export async function claimDevice(req: RequestUrlFn, endpoint: string, code: string, label: string): Promise<{ token: string; deviceId: string }> {
  const res = await call(req, `${trimSlash(endpoint)}/claim`, "POST", null, { code, label });
  if (res.status === 410) throw new InboxError("auth", "This setup code is invalid, expired or already used. Get a new one.");
  if (res.status === 429) throw new InboxError("server", "Too many attempts. Try again in a few minutes.");
  ensureOk(res, "Linking this device");
  const data = parseJson(res);
  if (!isObject(data) || typeof data.token !== "string" || !data.token) {
    throw new InboxError("server", "Unexpected response from the server");
  }
  const id = data.device_id;
  return { token: data.token, deviceId: typeof id === "number" || typeof id === "string" ? String(id) : "" };
}

export async function revokeDevice(req: RequestUrlFn, endpoint: string, token: string): Promise<void> {
  const res = await call(req, `${trimSlash(endpoint)}/device/revoke`, "POST", token);
  if (res.status !== 401) ensureOk(res, "Unlinking this device");
}

export function parseItems(data: unknown): { items: InboxItem[]; more: boolean } {
  if (!isObject(data) || !Array.isArray(data.items)) throw new InboxError("server", "Unexpected item list from the server");
  const items: InboxItem[] = [];
  for (const raw of data.items as unknown[]) {
    if (!isObject(raw) || typeof raw.id !== "string" || !Array.isArray(raw.files)) {
      throw new InboxError("server", "Unexpected item list from the server");
    }
    const files: InboxFile[] = [];
    for (const f of raw.files as unknown[]) {
      if (!isObject(f) || typeof f.seq !== "number" || typeof f.path !== "string" || typeof f.size !== "number" || typeof f.sha256 !== "string") {
        throw new InboxError("server", "Unexpected item list from the server");
      }
      files.push({ seq: f.seq, path: f.path, size: f.size, sha256: f.sha256 });
    }
    items.push({ id: raw.id, created_at: typeof raw.created_at === "string" ? raw.created_at : "", files });
  }
  return { items, more: data.more === true };
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function withSuffix(path: string, suffix: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)}-${suffix}${path.slice(dot)}` : `${path}-${suffix}`;
}

export type SyncInboxDeps = {
  req: RequestUrlFn;
  endpoint: string;
  token: string;
  io: VaultIO;
  /** Folder inside the vault to write into; empty = vault root. Already validated by the caller. */
  root: string;
  state: InboxState;
  /** Saves state. Called after every page, always before the acknowledgement for that page is sent. */
  persist: (state: InboxState) => Promise<void>;
  sha256?: (data: Uint8Array) => Promise<string>;
  now?: () => number;
};

export type SyncInboxResult = { written: number; acked: number; failed: number };

/** One round. Throws InboxError for auth and network problems; per-item problems are reported and retried later. */
export async function syncInbox(d: SyncInboxDeps): Promise<SyncInboxResult> {
  const sha = d.sha256 ?? webSha256;
  const now = d.now ?? Date.now;
  const base = trimSlash(d.endpoint);
  const state = d.state;
  const out: SyncInboxResult = { written: 0, acked: 0, failed: 0 };

  const ack = async (ids: string[], failed: { id: string; code: string }[]): Promise<number> => {
    const res = await call(d.req, `${base}/ack`, "POST", d.token, { ids, failed });
    ensureOk(res, "Confirming delivery");
    const data = parseJson(res);
    return isObject(data) && Array.isArray(data.acked) ? data.acked.length : 0;
  };

  const place = async (item: InboxItem, f: InboxFile, data: Uint8Array): Promise<boolean> => {
    let target = d.root ? `${d.root}/${validatePath(f.path)}` : validatePath(f.path);
    if (await d.io.exists(target)) {
      if ((await sha(await d.io.read(target))) === f.sha256) return false;   // already there, byte for byte
      target = withSuffix(target, item.id.slice(0, 8));                     // never overwrite someone else's file
      if (await d.io.exists(target)) {
        if ((await sha(await d.io.read(target))) === f.sha256) return false;
        throw new InboxError("server", "name_conflict");
      }
    }
    const dir = dirname(target);
    if (dir) await d.io.mkdirp(dir);
    const name = dir ? target.slice(dir.length + 1) : target;
    const tmp = dir ? `${dir}/.${name}.part` : `.${name}.part`;
    await d.io.write(tmp, data);
    await d.io.rename(tmp, target);
    if ((await sha(await d.io.read(target))) !== f.sha256) throw new InboxError("server", "verify_failed");
    return true;
  };

  if (state.pendingAcks.length) {
    out.acked += await ack(state.pendingAcks, []);
    state.pendingAcks = [];
    await d.persist(state);
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await call(d.req, `${base}/items?limit=${PAGE_LIMIT}`, "GET", d.token);
    ensureOk(res, "Listing new items");
    const { items, more } = parseItems(parseJson(res));
    const ids: string[] = [];
    const failed: { id: string; code: string }[] = [];
    for (const item of items) {
      if (state.ledger[item.id]) {
        ids.push(item.id);                    // written before but not confirmed: confirm, do not write again
        continue;
      }
      try {
        // attachments first, the note last: a note never points at a file that is not there yet
        const ordered = [...item.files].sort((a, b) => Number(a.seq === 0) - Number(b.seq === 0) || a.seq - b.seq);
        for (const f of ordered) {
          const dl = await call(d.req, `${base}/items/${encodeURIComponent(item.id)}/files/${f.seq}`, "GET", d.token);
          ensureOk(dl, "Download");
          const data = new Uint8Array(dl.arrayBuffer);
          if ((await sha(data)) !== f.sha256) throw new InboxError("server", "checksum_mismatch");
          if (await place(item, f, data)) out.written++;
        }
        state.ledger[item.id] = now();
        ids.push(item.id);
      } catch (e) {
        if (e instanceof InboxError && (e.kind === "auth" || e.kind === "network")) {
          await d.persist(state);
          throw e;
        }
        failed.push({ id: item.id, code: e instanceof InboxError ? e.message : "write_failed" });
        out.failed++;
      }
    }
    await d.persist(state);                   // record first: a lost acknowledgement only means one more acknowledgement
    if (ids.length || failed.length) {
      try {
        out.acked += await ack(ids, failed);
      } catch (e) {
        if (e instanceof InboxError && e.kind === "network") {
          state.pendingAcks = [...new Set([...state.pendingAcks, ...ids])];
          await d.persist(state);
        }
        throw e;
      }
    }
    if (!more || ids.length === 0) break;     // items that keep failing stay listed; do not page over them forever
  }

  const cutoff = now() - LEDGER_RETAIN_MS;
  for (const [id, at] of Object.entries(state.ledger)) if (at < cutoff) delete state.ledger[id];
  await d.persist(state);
  return out;
}
