import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MuninSdkError } from "@kalera/munin-sdk";
import { createMcpServerInstance } from "../src/mcp-server.js";
import { safeError } from "../src/index.js";

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function expectValidationError(result: ToolResult, toolName: string, scenario: string): void {
  assert.equal(result.isError, true, `${toolName} (${scenario}): expected isError=true`);
  const text = result.content?.[0]?.text ?? "";
  assert.match(
    text,
    /requires exactly one of 'key' or 'id'/,
    `${toolName} (${scenario}): expected XOR validation message, got: ${text}`,
  );
}

async function run() {
  assert.deepEqual(
    safeError(new MuninSdkError({
      code: "ERR_STALE_PROTOCOL",
      message: "ERR_STALE_PROTOCOL",
      details: {
        remediation: {
          version: "2026-04-17",
          setupGuideUrl: "https://example.test/setup",
          apiKey: "secret-value",
          instruction: "token=secret-value",
        },
      },
    })),
    {
      name: "MuninSdkError",
      message: "ERR_STALE_PROTOCOL",
      code: "ERR_STALE_PROTOCOL",
      details: {
        remediation: {
          version: "2026-04-17",
          setupGuideUrl: "https://example.test/setup",
          apiKey: "[REDACTED]",
          instruction: "token=[REDACTED]",
        },
      },
    },
  );

  const server = createMcpServerInstance(
    {
      baseUrl: "https://munin.kalera.dev",
      apiKey: "test-key",
      timeoutMs: 15_000,
      retries: 0,
      backoffMs: 0,
    },
    { allowMissingApiKey: true },
  );

  const client = new Client(
    { name: "runtime-validation-test-client", version: "1.4.4" },
    { capabilities: {} },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const xorTools: Array<{ name: string; extraArgs?: Record<string, unknown> }> = [
    { name: "munin_versions" },
    { name: "munin_rollback", extraArgs: { version: 1 } },
    { name: "munin_delete_memory" },
  ];

  const projectId = "test-project";

  for (const { name, extraArgs = {} } of xorTools) {
    const base = { projectId, ...extraArgs };
    expectValidationError(await callTool(client, name, { ...base }), name, "neither key nor id");
    expectValidationError(
      await callTool(client, name, { ...base, key: "k1", id: "i1" }),
      name,
      "both key and id",
    );
    expectValidationError(await callTool(client, name, { ...base, key: "" }), name, "empty key");
    expectValidationError(await callTool(client, name, { ...base, id: "" }), name, "empty id");
    expectValidationError(
      await callTool(client, name, { ...base, key: "", id: "" }),
      name,
      "both empty",
    );
  }

  const rollbackMissingVersion = await callTool(client, "munin_rollback", {
    projectId,
    key: "k1",
  });
  assert.equal(rollbackMissingVersion.isError, true, "munin_rollback: expected isError when version is missing");
  assert.match(
    rollbackMissingVersion.content?.[0]?.text ?? "",
    /numeric 'version'/,
    "munin_rollback: expected numeric version error message",
  );

  await Promise.all([client.close(), server.close()]);

  console.log("runtime validation tests passed");
}

void run();
