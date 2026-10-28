export type MuninAction =
  | "store"
  | "retrieve"
  | "search"
  | "list"
  | "recent"
  | "share"
  | "versions"
  | "rollback"
  | "encrypt"
  | "decrypt"
  | "diff"
  | "delete"
  | "acknowledge_setup";

export interface MuninActionEnvelope<TPayload = Record<string, unknown>> {
  action: MuninAction;
  project: string;
  payload: TPayload;
  requestId?: string;
  client?: {
    name: string;
    version: string;
  };
}

export interface MuninCapabilities {
  specVersion: string;
  actions: {
    core: string[];
    optional: string[];
  };
  features: Record<string, { supported: boolean; reason?: string }>;
  metadata: {
    serverVersion: string;
    timestamp: string;
    [key: string]: unknown;
  };
}

export interface MuninError {
  code:
    | "AUTH_INVALID"
    | "FEATURE_DISABLED"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "VALIDATION_ERROR"
    | "INTERNAL_ERROR"
    | "ERR_STALE_PROTOCOL"
    | "MAINTENANCE_READ_ONLY";
  message: string;
  details?: Record<string, unknown>;
}

export interface MuninResponse<TData = unknown> {
  ok: boolean;
  data?: TData;
  error?: MuninError;
  requestId?: string;
}

export interface MuninClientConfig {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Where refused writes wait. Default: ~/.munin under Node, none elsewhere. `false` disables queueing. */
  writeQueue?: import("./writeQueue.js").PendingWriteQueue | false;
  maintenanceRetry?: Partial<import("./maintenance.js").MaintenanceRetryPolicy>;
  /**
   * Before a write, how long the client may spend sending older queued writes
   * (default 5000). Whatever is still queued for the same project after that
   * makes the new write queue behind it instead of overtaking it.
   */
  flushBeforeWriteMs?: number;
  /**
   * Optionally re-adds stripped secrets (e.g. encryptionKey) at flush time.
   * Never required: the server ignores payload secrets on /api/mcp/action, so
   * null (or no rehydrator) sends the stored payload as is.
   */
  rehydratePayload?: (payload: Record<string, unknown>, strippedKeys: string[]) => Record<string, unknown> | null;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}
