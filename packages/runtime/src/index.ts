import * as fs from "fs";
import * as path from "path";

export interface ParsedCliArgs {
  action: string;
  payload: Record<string, unknown>;
}

export interface CliEnv {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  retries: number;
  backoffMs: number;
}

const REDACT_KEYS = ["apiKey", "authorization", "token", "secret", "password"];

export function parseCliArgs(argv: string[], usage: string): ParsedCliArgs {
  const [action, payloadRaw] = argv;
  if (!action) {
    throw new Error(usage);
  }

  if (!payloadRaw) {
    return { action, payload: {} };
  }

  try {
    return {
      action,
      payload: JSON.parse(payloadRaw) as Record<string, unknown>,
    };
  } catch {
    throw new Error("Payload must be valid JSON");
  }
}

/**
 * Resolve MUNIN_API_KEY — reads from process.env first, then walks up from CWD
 * for .env.local / .env files. This mirrors the MUNIN_PROJECT resolution pattern.
 */
export function resolveApiKey(): string | undefined {
  if (process.env.MUNIN_API_KEY) {
    return process.env.MUNIN_API_KEY;
  }
  // Walk upward from CWD — find .env.local first, then .env
  const fromLocal = resolveEnvFileUpward(".env.local", "MUNIN_API_KEY");
  if (fromLocal) return fromLocal;
  const fromEnv = resolveEnvFileUpward(".env", "MUNIN_API_KEY");
  if (fromEnv) return fromEnv;
  return undefined;
}

export function loadCliEnv(): CliEnv {
  return {
    baseUrl: process.env.MUNIN_BASE_URL || "https://munin.kalera.dev",
    apiKey: resolveApiKey(),
    timeoutMs: safeParseInt(process.env.MUNIN_TIMEOUT_MS, 15_000),
    retries: safeParseInt(process.env.MUNIN_RETRIES, 3),
    backoffMs: safeParseInt(process.env.MUNIN_BACKOFF_MS, 300),
  };
}

function safeParseInt(envVal: string | undefined, defaultVal: number): number {
  if (envVal === undefined) return defaultVal;
  const parsed = Number(envVal);
  return isNaN(parsed) ? defaultVal : parsed;
}

/**
 * Walk up the directory tree from `startDir` (default CWD) toward root,
 * searching each ancestor for a .env file containing `key=`. Returns the value
 * of the first match. Stops at filesystem root or when a `.git` dir is found
 * (project boundary).
 */
function resolveEnvFileUpward(
  filename: string,
  key: string,
  startDir?: string,
): string | undefined {
  let current = startDir ?? process.cwd();
  let last = "";

  while (current !== last) {
    last = current;
    const filePath = path.join(current, filename);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        const prefix = `${key}=`;
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith(prefix)) continue;
          return trimmed.slice(prefix.length).trim();
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[munin-runtime] Failed to read ${filePath}:`, error);
      }
    }

    // Stop at git root (project boundary)
    if (fs.existsSync(path.join(current, ".git"))) break;

    current = path.dirname(current);
  }
  return undefined;
}

/**
 * Resolve MUNIN_PROJECT from multiple sources, in priority order:
 * 1. Explicit environment variable
 * 2. .env.local in any ancestor directory (walk-up from CWD)
 * 3. .env in any ancestor directory (walk-up from CWD)
 */
export function resolveProjectId(): string | undefined {
  // 1. Explicit env var (highest priority)
  if (process.env.MUNIN_PROJECT) {
    return process.env.MUNIN_PROJECT;
  }

  // 2. Walk upward from CWD — find .env.local in any ancestor dir
  const fromLocal = resolveEnvFileUpward(".env.local", "MUNIN_PROJECT");
  if (fromLocal) return fromLocal;

  // 3. Walk upward from CWD — find .env in any ancestor dir
  const fromEnv = resolveEnvFileUpward(".env", "MUNIN_PROJECT");
  if (fromEnv) return fromEnv;

  return undefined;
}

export async function executeWithRetry<T>(
  task: () => Promise<T>,
  retries: number,
  backoffMs: number,
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < retries) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      // The SDK already retried a maintenance refusal (and queued a write): never resend it here.
      if ((error as { retryable?: unknown } | null)?.retryable === false) break;
      attempt += 1;
      if (attempt >= retries) break;
      const jitter = Math.floor(Math.random() * 100);
      await sleep(backoffMs * 2 ** attempt + jitter);
    }
  }

  throw lastError;
}

export function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const safe: Record<string, unknown> = {
      name: error.name,
      message: redactText(error.message),
    };

    // MuninSdkError carries structured `code` + `details`; preserve them so
    // callers can branch on the code, but redact any secrets nested in details
    // (both secret-named keys and inline `token=...` patterns in values).
    const sdkError = error as Error & { code?: unknown; details?: unknown };
    if (error.name === "MuninSdkError" || error.name === "MuninMaintenanceError") {
      if (sdkError.code !== undefined) safe.code = sdkError.code;
      if (sdkError.details !== undefined) safe.details = redactValue(sdkError.details);
    }

    return safe;
  }

  return { message: redactText(String(error)) };
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEYS.some((redactKey) => redactKey.toLowerCase() === lower);
}

/**
 * Recursively redact secrets from an arbitrary value. A property whose KEY is a
 * known secret (apiKey, token, …) has its value replaced wholesale; every other
 * string is passed through inline `redactText` so embedded `token=...` secrets
 * are scrubbed without losing surrounding context.
 */
function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] =
        isSecretKey(key) && (val === null || typeof val !== "object")
          ? "[REDACTED]"
          : redactValue(val);
    }
    return out;
  }
  return value;
}

function redactText(text: string): string {
  return REDACT_KEYS.reduce((acc, key) => {
    const pattern = new RegExp(`${key}\\s*[:=]\\s*[^\\s,]+`, "gi");
    return acc.replace(pattern, `${key}=[REDACTED]`);
  }, text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export * from "./mcp-server.js";
export * from "./env.js";
