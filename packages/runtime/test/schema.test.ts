import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SERVER_VERSION } from "@kalera/munin-shared-version";
import { createMcpServerInstance } from "../src/mcp-server.js";

async function run() {
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
    {
      name: "runtime-schema-test-client",
      version: "1.5.0",
    },
    {
      capabilities: {},
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  assert.equal(client.getServerVersion()?.version, SERVER_VERSION);

  const response = await client.listTools();

  const tools = response.tools ?? [];
  for (const toolName of ["munin_versions", "munin_rollback", "munin_delete_memory"]) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    assert.ok(tool, `expected ${toolName} to be registered`);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal("oneOf" in tool.inputSchema, false, `${toolName} must not expose top-level oneOf`);
    assert.equal("anyOf" in tool.inputSchema, false, `${toolName} must not expose top-level anyOf`);
    assert.equal("allOf" in tool.inputSchema, false, `${toolName} must not expose top-level allOf`);
  }

  await Promise.all([client.close(), server.close()]);

  console.log("runtime schema tests passed");
}

void run();
