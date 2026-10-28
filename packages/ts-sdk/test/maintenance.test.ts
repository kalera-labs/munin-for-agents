import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MuninClient } from "../src/client";
import { MuninMaintenanceError, MuninSdkError } from "../src/errors";
import { MemoryWriteQueue } from "../src/writeQueue";
import { createFileWriteQueue } from "../src/node/fileWriteQueue";

type Scripted = { status: number; body: unknown; headers?: Record<string, string> };
const MAINTENANCE: Scripted = {
  status: 503,
  body: { ok: false, error: "MAINTENANCE_READ_ONLY", retryAfter: 900 },
  headers: { "Retry-After": "900" },
};
const OK: Scripted = { status: 200, body: { ok: true, data: { stored: true } } };

function scriptedFetch(script: Scripted[]) {
  const requests: Array<Record<string, any>> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const next = script.length > 1 ? script.shift()! : script[0];
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json", ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function client(fetchImpl: typeof fetch, writeQueue: MemoryWriteQueue | false, sleeps: number[] = []) {
  return new MuninClient({
    baseUrl: "http://munin.test",
    apiKey: "key-a",
    fetchImpl,
    writeQueue,
    sleep: async (ms) => { sleeps.push(ms); },
    rehydratePayload: (payload, keys) => (keys.includes("encryptionKey") ? { ...payload, encryptionKey: "env-key" } : payload),
  });
}

async function run() {
  // 1. A write that hits the freeze once is retried and lands.
  {
    const { fetchImpl, requests } = scriptedFetch([MAINTENANCE, OK]);
    const queue = new MemoryWriteQueue();
    const result = await client(fetchImpl, queue).invoke("p1", "store", { key: "k", content: "c" });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.equal(await queue.size(), 0);
  }

  // 2. A write refused for the whole retry budget is queued without its secrets.
  const queue = new MemoryWriteQueue();
  {
    const sleeps: number[] = [];
    const { fetchImpl, requests } = scriptedFetch([MAINTENANCE]);
    await assert.rejects(
      client(fetchImpl, queue, sleeps).invoke("p1", "store", { key: "k2", content: "c2", encryptionKey: "secret" }),
      (error: unknown) => {
        assert.ok(error instanceof MuninMaintenanceError);
        assert.equal(error.code, "MAINTENANCE_READ_ONLY");
        assert.equal(error.queued, true);
        assert.match(error.message, /maintenance/i);
        assert.match(error.message, /retried/i);
        return true;
      },
    );
    assert.equal(requests.length, 3, "first attempt + 2 bounded retries");
    assert.deepEqual(sleeps, [5_000, 5_000], "Retry-After 900 s is capped at maxWaitMs");
    assert.equal(await queue.size(), 1);
    let stored = "";
    await queue.drain(async (w) => { stored = JSON.stringify(w); return "keep"; });
    assert.equal(stored.includes("secret"), false, "the E2EE key never reaches the queue");
  }

  // 3. A read is retried but never queued.
  {
    const readQueue = new MemoryWriteQueue();
    const { fetchImpl } = scriptedFetch([MAINTENANCE]);
    await assert.rejects(client(fetchImpl, readQueue).invoke("p1", "search", { query: "q" }), (error: unknown) => {
      assert.ok(error instanceof MuninMaintenanceError);
      assert.equal(error.queued, false);
      return true;
    });
    assert.equal(await readQueue.size(), 0);
  }

  // 4. Another 503 is an ordinary error, not maintenance.
  {
    const { fetchImpl } = scriptedFetch([{ status: 503, body: { ok: false, error: "AnonPay webhook verification unavailable" } }]);
    const other = new MemoryWriteQueue();
    await assert.rejects(client(fetchImpl, other).invoke("p1", "store", { key: "k" }), (error: unknown) => {
      assert.ok(error instanceof MuninSdkError);
      assert.equal(error instanceof MuninMaintenanceError, false);
      return true;
    });
    assert.equal(await other.size(), 0);
  }

  // 5. The next successful call flushes the queue, with the key re-resolved.
  {
    const { fetchImpl, requests } = scriptedFetch([OK]);
    const c = client(fetchImpl, queue);
    await c.invoke("p1", "search", { query: "q" });
    const report = await c.flushPendingWrites();
    assert.equal(report.remaining, 0);
    const replayed = requests.find((r) => r.action === "store");
    assert.equal(replayed?.payload.key, "k2");
    assert.equal(replayed?.payload.encryptionKey, "env-key");
    assert.equal(await queue.size(), 0);
  }

  // 6. A flush that meets the freeze again keeps everything.
  {
    const q = new MemoryWriteQueue();
    const { fetchImpl: down } = scriptedFetch([MAINTENANCE]);
    await assert.rejects(client(down, q).invoke("p1", "store", { key: "a" }));
    await assert.rejects(client(down, q).invoke("p1", "delete", { key: "b" }));
    const report = await client(down, q).flushPendingWrites();
    assert.equal(report.remaining, 2);
  }

  // 7. A write the server rejects for good is dead-lettered, not retried forever.
  {
    const q = new MemoryWriteQueue();
    const { fetchImpl: down } = scriptedFetch([MAINTENANCE]);
    await assert.rejects(client(down, q).invoke("p1", "store", { key: "bad" }));
    const { fetchImpl: invalid } = scriptedFetch([{ status: 400, body: { ok: false, error: "VALIDATION_ERROR" } }]);
    const report = await client(invalid, q).flushPendingWrites();
    assert.equal(report.dead, 1);
    assert.equal(await q.size(), 0);
    assert.equal(q.deadLetters.length, 1);
  }

  // 8. A write queued under another API key is left alone.
  {
    const q = new MemoryWriteQueue();
    const { fetchImpl: down } = scriptedFetch([MAINTENANCE]);
    await assert.rejects(client(down, q).invoke("p1", "store", { key: "mine" }));
    const { fetchImpl: up, requests } = scriptedFetch([OK]);
    const otherKey = new MuninClient({ baseUrl: "http://munin.test", apiKey: "key-b", fetchImpl: up, writeQueue: q });
    await otherKey.flushPendingWrites();
    assert.equal(requests.length, 0);
    assert.equal(await q.size(), 1);
  }

  // 9. The file queue survives a new process, is private, and is bounded by a lock.
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "munin-sdk-queue-"));
    const first = createFileWriteQueue(dir);
    const { fetchImpl: down } = scriptedFetch([MAINTENANCE]);
    await assert.rejects(new MuninClient({ baseUrl: "http://munin.test", apiKey: "key-a", fetchImpl: down, writeQueue: first, sleep: async () => {} })
      .invoke("p1", "store", { key: "persisted" }));
    const stat = await fs.stat(path.join(dir, "pending-writes.jsonl"));
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);

    const second = createFileWriteQueue(dir); // "process start"
    assert.equal(await second.size(), 1);
    const { fetchImpl: up } = scriptedFetch([OK]);
    const report = await new MuninClient({ baseUrl: "http://munin.test", apiKey: "key-a", fetchImpl: up, writeQueue: second })
      .flushPendingWrites();
    assert.equal(report.sent, 1);
    assert.equal(await second.size(), 0);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // 10. A newer write never overtakes an older queued write to the same key:
  //     the queue is flushed BEFORE the new write is sent.
  {
    const q = new MemoryWriteQueue();
    const { fetchImpl: down } = scriptedFetch([MAINTENANCE]);
    await assert.rejects(client(down, q).invoke("p1", "store", { key: "k", content: "old" }));
    const { fetchImpl: up, requests } = scriptedFetch([OK]);
    await client(up, q).invoke("p1", "store", { key: "k", content: "new" });
    assert.deepEqual(requests.map((r) => r.payload.content), ["old", "new"], "the queued write goes first");
    assert.equal(await q.size(), 0);
  }

  // 11. When the queued write cannot go out within flushBeforeWriteMs, the new
  //     write is queued behind it instead of being sent ahead of it, and the
  //     next flush keeps the order.
  {
    const q = new MemoryWriteQueue();
    const { fetchImpl: down } = scriptedFetch([MAINTENANCE]);
    await assert.rejects(client(down, q).invoke("p1", "delete", { key: "k" }));
    const { fetchImpl: up, requests } = scriptedFetch([OK]);
    const impatient = new MuninClient({ baseUrl: "http://munin.test", apiKey: "key-a", fetchImpl: up, writeQueue: q, flushBeforeWriteMs: 0 });
    await assert.rejects(impatient.invoke("p1", "store", { key: "k", content: "after-delete" }), (error: unknown) => {
      assert.ok(error instanceof MuninMaintenanceError);
      assert.equal(error.queued, true);
      return true;
    });
    assert.equal(requests.length, 0, "nothing may overtake the queued delete");
    assert.equal(await q.size(), 2);
    await impatient.flushPendingWrites();
    assert.deepEqual(requests.map((r) => r.action), ["delete", "store"]);
  }

  // 12. A write is not held hostage by a long flush that is already running
  //     without a deadline (e.g. the one started after a successful read):
  //     flushBeforeWriteMs tightens it, the rest stays queued, in order, and
  //     the new write queues behind it.
  {
    const q = new MemoryWriteQueue();
    const { fetchImpl: down } = scriptedFetch([MAINTENANCE]);
    for (let i = 0; i < 20; i++) {
      await assert.rejects(client(down, q).invoke("p1", "store", { key: `k${i}` }));
    }
    const sent: string[] = [];
    const slow = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      sent.push(String(JSON.parse(String(init?.body)).payload.key));
      return new Response(JSON.stringify(OK.body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const c = new MuninClient({ baseUrl: "http://munin.test", apiKey: "key-a", fetchImpl: slow, writeQueue: q, flushBeforeWriteMs: 120 });
    const background = c.flushPendingWrites(); // no deadline
    const started = Date.now();
    await assert.rejects(c.invoke("p1", "store", { key: "newest" }), (error: unknown) => {
      assert.ok(error instanceof MuninMaintenanceError);
      assert.equal(error.queued, true);
      return true;
    });
    assert.ok(Date.now() - started < 600, `bounded by flushBeforeWriteMs plus one request (took ${Date.now() - started} ms)`);
    await background;
    assert.ok(sent.length < 20, "the running flush stopped at the tightened deadline");
    assert.equal(sent.includes("newest"), false);
    await c.flushPendingWrites();
    assert.deepEqual(sent, [...Array.from({ length: 20 }, (_, i) => `k${i}`), "newest"], "order kept across the interrupted flush");
  }

  console.log("maintenance.test.ts: all cases passed");
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
