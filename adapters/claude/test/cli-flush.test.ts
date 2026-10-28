/**
 * The one-shot CLI (run once per Claude Code session by the plugin's
 * session-start hook) flushes writes a maintenance window left in the local
 * queue before it exits, and does not linger once the flush is done.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyFingerprint, type PendingWrite } from "@kalera/munin-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.ts");
const API_KEY = "cli-test-key";

const CAPABILITIES = {
  ok: true,
  data: {
    specVersion: "v1.0.0",
    actions: { core: ["store", "retrieve", "search", "list", "recent"], optional: ["share"] },
    features: {},
    metadata: { serverVersion: "test", timestamp: new Date(0).toISOString() },
  },
};

function startServer(seen: Array<Record<string, any>>, delayMs = 0): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/api/mcp/capabilities")) {
        res.end(JSON.stringify(CAPABILITIES));
        return;
      }
      setTimeout(() => {
        seen.push(JSON.parse(raw));
        res.end(JSON.stringify({ ok: true, data: [] }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - started }));
  });
}

async function run() {
  const seen: Array<Record<string, any>> = [];
  const server = await startServer(seen);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), "munin-cli-queue-"));
  const queued: PendingWrite = {
    id: "queued-1",
    queuedAt: new Date().toISOString(),
    baseUrl,
    keyFingerprint: await keyFingerprint(API_KEY),
    projectId: "p1",
    action: "store",
    payload: { key: "from-the-freeze", content: "c" },
    // Queued by the MCP server with MUNIN_ENCRYPTION_KEY set: the CLI has no
    // rehydrator and must still send it (the server ignores payload.encryptionKey).
    strippedKeys: ["encryptionKey"],
  };
  await fs.writeFile(path.join(queueDir, "pending-writes.jsonl"), `${JSON.stringify(queued)}\n`, { mode: 0o600 });

  try {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: queueDir,
      MUNIN_BASE_URL: baseUrl,
      MUNIN_API_KEY: API_KEY,
      MUNIN_QUEUE_DIR: queueDir,
    };
    const result = await runCli(["recent", JSON.stringify({ projectId: "p1", limit: 5 })], env);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(seen.map((r) => r.action), ["recent", "store"], "the read goes out, then the queued write");
    assert.equal(seen[1].payload.key, "from-the-freeze");
    await assert.rejects(fs.stat(path.join(queueDir, "pending-writes.dead.jsonl")), "nothing dead-lettered");
    assert.equal((await fs.readFile(path.join(queueDir, "pending-writes.jsonl"), "utf8")).trim(), "");
    assert.ok(result.ms < 4_500, `the CLI must exit once the flush is done, not after the 5 s bound (took ${result.ms} ms)`);
  } finally {
    server.close();
    await fs.rm(queueDir, { recursive: true, force: true });
  }

  // A long queue on a slow server: the CLI stops sending at its 5 s budget,
  // keeps the rest queued in order, and exits instead of draining everything.
  {
    const slowSeen: Array<Record<string, any>> = [];
    const slow = await startServer(slowSeen, 250);
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "munin-cli-queue-"));
    const fingerprint = await keyFingerprint(API_KEY);
    const lines = Array.from({ length: 60 }, (_, i) => JSON.stringify({
      id: `q${i}`, queuedAt: new Date().toISOString(), baseUrl: slowUrl, keyFingerprint: fingerprint,
      projectId: "p1", action: "store", payload: { key: `k${i}` }, strippedKeys: [],
    } satisfies PendingWrite));
    await fs.writeFile(path.join(dir, "pending-writes.jsonl"), lines.map((l) => `${l}\n`).join(""), { mode: 0o600 });
    try {
      const result = await runCli(["recent", JSON.stringify({ projectId: "p1" })], {
        PATH: process.env.PATH, HOME: dir, MUNIN_BASE_URL: slowUrl, MUNIN_API_KEY: API_KEY, MUNIN_QUEUE_DIR: dir,
      });
      assert.equal(result.code, 0, result.stdout);
      assert.ok(result.ms < 9_000, `bounded flush (took ${result.ms} ms; an unbounded drain takes ~15 s)`);
      const left = (await fs.readFile(path.join(dir, "pending-writes.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).id);
      const sent = slowSeen.filter((r) => r.action === "store").length;
      assert.ok(sent > 0 && left.length > 0, `some sent (${sent}), some left (${left.length})`);
      assert.deepEqual(left, Array.from({ length: 60 - sent }, (_, i) => `q${i + sent}`), "the rest stays queued, in order");
      await assert.rejects(fs.stat(path.join(dir, "pending-writes.lock")), "the lock is released before exit");
      await assert.rejects(fs.stat(path.join(dir, "pending-writes.drain.lock")), "the drain lock is released before exit");
    } finally {
      slow.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  console.log("adapter-claude cli flush tests passed");
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
