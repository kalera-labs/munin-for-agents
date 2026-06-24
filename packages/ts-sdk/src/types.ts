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
    | "INTERNAL_ERROR";
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
}
