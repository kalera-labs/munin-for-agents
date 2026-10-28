import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MuninMaintenanceError, keyFingerprint } from "@kalera/munin-sdk";
import { createMcpServerInstance } from "../src/mcp-server.js";
import { executeWithRetry, safeError } from "../src/index.js";

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

const BASE_URL = "http://munin.test";
const CAPABILITIES = {
  ok: true,
  data: {
    specVersion: "v1.0.0",
    actions: { core: ["store", "retrieve", "search", "list", "recent"], optional: ["share"] },
    features: {},
    metadata: { serverVersion: "test", timestamp: new Date(0).toISOString() },
  },
};

/** Answers every /api/mcp/action call with `actionStatus`; retryAfter 0 keeps the SDK backoff at 1 s + 2 s. */
function stubFetch(mode: "maintenance" | "ok", seen: Array<Record<string, any>>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/mcp/capabilities")) {
      return new Response(JSON.stringify(CAPABILITIES), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    seen.push(JSON.parse(String(init?.body)));
    const body = mode === "maintenance"
      ? { ok: false, error: "MAINTENANCE_READ_ONLY", retryAfter: 0 }
      : { ok: true, data: { stored: true } };
    return new Response(JSON.stringify(body), {
      status: mode === "maintenance" ? 503 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

async function connect() {
  const server = createMcpServerInstance({ baseUrl: BASE_URL, apiKey: "key-a", timeoutMs: 5_000, retries: 0, backoffMs: 0 });
  const client = new Client({ name: "runtime-maintenance-test-client", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    call: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult,
    close: () => Promise.all([client.close(), server.close()]),
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function run() {
  const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), "munin-runtime-queue-"));
  process.env.MUNIN_QUEUE_DIR = queueDir;
  process.env.MUNIN_ENCRYPTION_KEY = "env-e2ee-key";
  const queueFile = path.join(queueDir, "pending-writes.jsonl");
  const realFetch = globalThis.fetch;

  try {
    // 1. executeWithRetry does not retry an error that says it is not retryable.
    {
      let calls = 0;
      await assert.rejects(
        executeWithRetry(async () => {
          calls += 1;
          throw new MuninMaintenanceError({ queued: true, action: "store", retryAfterMs: null });
        }, 3, 0),
        MuninMaintenanceError,
      );
      assert.equal(calls, 1, "the SDK already retried and queued; the CLI must not resend");
    }

    // 2. safeError keeps code and details for MuninSdkError subclasses.
    {
      const safe = safeError(new MuninMaintenanceError({ queued: false, action: "search", retryAfterMs: 900_000 }));
      assert.equal(safe.code, "MAINTENANCE_READ_ONLY");
      assert.equal((safe.details as Record<string, unknown>).action, "search");
    }

    // 3. During the freeze a store is answered as a queued, non-error result,
    //    and the queue on disk holds no E2EE key; a read is an error, never queued.
    {
      const seen: Array<Record<string, any>> = [];
      globalThis.fetch = stubFetch("maintenance", seen);
      const mcp = await connect();
      const stored = await mcp.call("munin_store_memory", { projectId: "p1", key: "k", content: "c" });
      assert.equal(stored.isError, false);
      const storedBody = JSON.parse(stored.content?.[0]?.text ?? "{}");
      assert.equal(storedBody.maintenance, true);
      assert.equal(storedBody.queued, true);
      assert.match(storedBody.message, /maintenance/i);
      assert.equal(seen.filter((r) => r.action === "store").length, 3, "first attempt + 2 bounded retries");
      assert.equal(seen[0].payload.encryptionKey, "env-e2ee-key", "a live call still sends the key");
      const onDisk = await fs.readFile(queueFile, "utf8");
      assert.equal(onDisk.trim().split("\n").length, 1);
      assert.equal(onDisk.includes("env-e2ee-key"), false, "the E2EE key never reaches the queue");

      const searched = await mcp.call("munin_search_memories", { projectId: "p1", query: "q" });
      assert.equal(searched.isError, true);
      assert.equal(JSON.parse(searched.content?.[0]?.text ?? "{}").queued, false);
      assert.equal((await fs.readFile(queueFile, "utf8")).trim().split("\n").length, 1, "reads are never queued");
      await mcp.close();
    }

    // 4. A new MCP server process flushes the queue at start, with the key re-resolved from the environment.
    {
      const seen: Array<Record<string, any>> = [];
      globalThis.fetch = stubFetch("ok", seen);
      const mcp = await connect();
      await waitFor(async () => (await fs.readFile(queueFile, "utf8")).trim() === "");
      const replayed = seen.find((r) => r.action === "store");
      assert.equal(replayed?.payload.key, "k");
      assert.equal(replayed?.payload.encryptionKey, "env-e2ee-key");
      await mcp.close();
    }

    // 5. A queued write that could not be delivered (here: older than 24 h) is
    //    reported once in the next tool result, with the dead-letter file.
    {
      const stale = {
        id: "stale-1",
        queuedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
        baseUrl: BASE_URL,
        keyFingerprint: await keyFingerprint("key-a"),
        projectId: "p1",
        action: "store",
        payload: { key: "old" },
        strippedKeys: [],
      };
      await fs.writeFile(queueFile, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
      const seen: Array<Record<string, any>> = [];
      globalThis.fetch = stubFetch("ok", seen);
      const mcp = await connect();
      await waitFor(async () => (await fs.readFile(queueFile, "utf8")).trim() === "");
      const first = JSON.parse((await mcp.call("munin_search_memories", { projectId: "p1", query: "q" })).content?.[0]?.text ?? "{}");
      assert.equal(first.queueNotice?.deadLettered, 1);
      assert.match(first.queueNotice?.message ?? "", /could not be delivered/);
      assert.equal(first.queueNotice?.file, path.join(queueDir, "pending-writes.dead.jsonl"));
      const second = JSON.parse((await mcp.call("munin_search_memories", { projectId: "p1", query: "q" })).content?.[0]?.text ?? "{}");
      assert.equal(second.queueNotice, undefined, "reported once");
      assert.equal(seen.some((r) => r.payload?.key === "old"), false, "a stale write is never replayed");
      await mcp.close();
    }

    // 6. A queued result says how many writes wait locally.
    {
      globalThis.fetch = stubFetch("maintenance", []);
      const mcp = await connect();
      await mcp.call("munin_store_memory", { projectId: "p1", key: "a", content: "c" });
      const body = JSON.parse((await mcp.call("munin_store_memory", { projectId: "p1", key: "b", content: "c" })).content?.[0]?.text ?? "{}");
      assert.equal(body.queued, true);
      assert.equal(body.pendingWrites, 2);
      await mcp.close();
    }
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(queueDir, { recursive: true, force: true });
  }

  console.log("runtime maintenance tests passed");
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
