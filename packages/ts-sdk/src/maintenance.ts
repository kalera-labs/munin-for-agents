/**
 * Client side of the Munin write freeze (server: MUNIN_READ_ONLY). During a
 * maintenance window every write answers 503 with error MAINTENANCE_READ_ONLY
 * and a Retry-After header; reads keep working.
 */
export const MAINTENANCE_ERROR_CODE = "MAINTENANCE_READ_ONLY";

/** Mutating actions by every alias the server accepts (server/config/maintenance.ts MCP_WRITE_ACTIONS). */
export const WRITE_ACTIONS: ReadonlySet<string> = new Set([
  "store",
  "store_memory",
  "store_batch",
  "share",
  "delete",
  "delete_memory",
  "rollback",
  "acknowledge_setup",
]);

export function isWriteAction(action: string): boolean {
  return WRITE_ACTIONS.has(String(action).toLowerCase());
}

export function isDeleteAction(action: string): boolean {
  const name = String(action).toLowerCase();
  return name === "delete" || name === "delete_memory";
}

function errorCodeOf(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "";
}

export function isMaintenanceResponse(status: number, body: unknown): boolean {
  return status === 503 && errorCodeOf(body) === MAINTENANCE_ERROR_CODE;
}

/**
 * A reverse proxy or CDN answering for a Munin that is restarting or
 * unreachable (502, 503 without MAINTENANCE_READ_ONLY, 504, Cloudflare 52x),
 * or any 5xx whose body is not a JSON object (Munin always answers JSON).
 * Treated like a transport error: the replay stops, nothing is counted.
 */
export function isGatewayResponse(status: number, jsonBody: boolean): boolean {
  if (status < 500) return false;
  if (!jsonBody) return true;
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 529);
}

/** Retry-After in ms: the header (seconds or an HTTP date) wins over the body's `retryAfter` seconds. */
export function retryAfterMs(header: string | null, body: unknown, now: number = Date.now()): number | null {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const fromBody = Number((body as { retryAfter?: unknown } | null)?.retryAfter);
  return Number.isFinite(fromBody) && fromBody >= 0 ? fromBody * 1000 : null;
}

export interface MaintenanceRetryPolicy {
  /** Retries after the first attempt. */
  retries: number;
  /** Longest single wait whatever Retry-After says: the server advertises 900 s. */
  maxWaitMs: number;
}

export const DEFAULT_MAINTENANCE_RETRY: MaintenanceRetryPolicy = { retries: 2, maxWaitMs: 5_000 };

/** Exponential from 1 s, at least Retry-After, never above maxWaitMs. */
export function maintenanceDelayMs(attempt: number, retryAfter: number | null, policy: MaintenanceRetryPolicy): number {
  return Math.min(Math.max(1_000 * 2 ** attempt, retryAfter ?? 0), policy.maxWaitMs);
}

/** Payload keys that must never be written to the local queue. */
export const SECRET_PAYLOAD_KEYS: readonly string[] = ["encryptionKey", "apiKey"];

export function stripSecrets(payload: Record<string, unknown>): { payload: Record<string, unknown>; strippedKeys: string[] } {
  const strippedKeys = SECRET_PAYLOAD_KEYS.filter((key) => key in payload);
  const kept = Object.fromEntries(Object.entries(payload).filter(([key]) => !SECRET_PAYLOAD_KEYS.includes(key)));
  return { payload: kept, strippedKeys };
}

/** sha-256 of the API key, first 16 hex chars: ties a queued write to its key without storing the key. */
export async function keyFingerprint(apiKey: string | undefined): Promise<string> {
  if (!apiKey) return "anonymous";
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
