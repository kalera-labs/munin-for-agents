import assert from "node:assert/strict";
import { VERSION } from "@kalera/munin-shared-version";
import { MuninClient } from "../src/client";
import { MuninSdkError } from "../src/errors";

async function run() {
  let actionRequest: Record<string, any> | undefined;
  const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith("/api/mcp/capabilities")) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            specVersion: "v1.0.0",
            actions: {
              core: ["store", "retrieve", "search", "list", "recent"],
              optional: ["share"],
            },
            features: {
              encryption: { supported: true },
            },
            metadata: {
              serverVersion: "1.5.0",
              timestamp: new Date().toISOString(),
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/api/mcp/action") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      actionRequest = body;
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            echoedAction: body.action,
            echoedProject: body.project,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  }) as typeof fetch;

  const client = new MuninClient({
    baseUrl: "http://localhost:4000",
    fetchImpl: fakeFetch,
  });

  const capabilities = await client.capabilities();
  assert.equal(capabilities.specVersion, "v1.0.0");

  const result = await client.store("default", { key: "hello", content: "world" });
  assert.equal(result.ok, true);
  assert.equal((result.data as any).echoedAction, "store");
  assert.equal(actionRequest?.client.version, VERSION);

  const remediation = {
    version: "2026-04-17",
    setupGuideUrl: "https://example.test/setup",
  };
  const staleClient = new MuninClient({
    baseUrl: "http://localhost:4000",
    fetchImpl: (async () => new Response(
      JSON.stringify({
        ok: false,
        error: "ERR_STALE_PROTOCOL",
        remediation,
      }),
      { status: 426, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch,
  });

  await assert.rejects(
    staleClient.invoke("default", "store", { key: "hello", content: "world" }),
    (error: unknown) => {
      assert.ok(error instanceof MuninSdkError);
      assert.equal(error.code, "ERR_STALE_PROTOCOL");
      assert.equal(error.message, "ERR_STALE_PROTOCOL");
      assert.deepEqual(error.details, { remediation });
      return true;
    },
  );

  const structuredClient = new MuninClient({
    baseUrl: "http://localhost:4000",
    fetchImpl: (async () => new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request",
          details: { field: "key" },
        },
        remediation,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch,
  });

  await assert.rejects(
    structuredClient.invoke("default", "store", {}),
    (error: unknown) => {
      assert.ok(error instanceof MuninSdkError);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.deepEqual(error.details, { field: "key", remediation });
      return true;
    },
  );

  console.log("sdk-ts tests passed");
}

void run();
