import { MuninSdkError, MuninTransportError } from "./errors.js";
import { fetchCapabilities, isActionSupported } from "./capabilities.js";
import type {
  MuninAction,
  MuninClientConfig,
  MuninResponse,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export class MuninClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config?: MuninClientConfig) {
    this.baseUrl = (config?.baseUrl || "https://munin.kalera.dev").replace(/\/$/, "");
    this.apiKey = config?.apiKey;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config?.fetchImpl ?? fetch;
  }

  async capabilities(forceRefresh = false) {
    if (!forceRefresh && (globalThis as Record<string, unknown>).__munin_caps) {
      return (globalThis as Record<string, unknown>).__munin_caps as Awaited<ReturnType<typeof fetchCapabilities>>;
    }
    const caps = await fetchCapabilities(this.baseUrl, this.apiKey, this.fetchImpl);
    (globalThis as Record<string, unknown>).__munin_caps = caps;
    return caps;
  }

  async invoke<TPayload extends Record<string, unknown>, TData = unknown>(
    projectId: string,
    action: MuninAction,
    payload: TPayload,
    options?: { requestId?: string; ensureCapability?: boolean },
  ): Promise<any> {
    if (options?.ensureCapability) {
      const caps = await this.capabilities();
      if (!isActionSupported(caps, action)) {
        throw new MuninSdkError({
          code: "FEATURE_DISABLED",
          message: `Action '${action}' is not supported by current server capabilities`,
        });
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const response = await this.fetchImpl(`${this.baseUrl}/api/mcp/action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiKey: this.apiKey,
        project: projectId,
        projectId, // Fallback for un-restarted server
        action,
        payload,
        requestId: options?.requestId,
        client: {
          name: "@kalera/munin-sdk",
          version: "1.4.1",
        },
      }),
      signal: controller.signal,
    }).catch((error: unknown) => {
      clearTimeout(timeout);
      throw new MuninTransportError(
        `Request failed for action '${action}': ${String(error)}`,
      );
    });

    clearTimeout(timeout);

    const body = (await response.json()) as any;

    if (!response.ok || (body.ok === false) || (body.success === false)) {
      let errObj = body.error;
      if (typeof errObj === "string") {
        errObj = { code: "INTERNAL_ERROR", message: errObj };
      }

      throw new MuninSdkError(
        errObj ?? {
          code: "INTERNAL_ERROR" as const,
          message: `Unexpected failure invoking action '${action}'`,
        },
      );
    }

    return body as any;
  }

  async store(projectId: string, payload: Record<string, unknown>): Promise<any> {
    return this.invoke(projectId, "store", payload, { ensureCapability: true });
  }

  async retrieve(projectId: string, payload: Record<string, unknown>): Promise<any> {
    return this.invoke(projectId, "retrieve", payload, { ensureCapability: true });
  }

  async search(projectId: string, payload: Record<string, unknown>): Promise<any> {
    return this.invoke(projectId, "search", payload, { ensureCapability: true });
  }

  async list(projectId: string, payload: Record<string, unknown> = {}): Promise<any> {
    return this.invoke(projectId, "list", payload, { ensureCapability: true });
  }

  async recent(projectId: string, payload: Record<string, unknown> = {}): Promise<any> {
    return this.invoke(projectId, "recent", payload, { ensureCapability: true });
  }

  async share(
    projectId: string,
    memoryIds: string[],
    targetProjectIds: string[],
  ): Promise<any> {
    return this.invoke(projectId, "share", { memoryIds, targetProjectIds }, { ensureCapability: true });
  }
}
