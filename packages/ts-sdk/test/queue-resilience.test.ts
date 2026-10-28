/**
 * Queue resilience: a queued write is never lost because a secret was
 * stripped, a slow drain never blocks other processes from queueing, a
 * failing entry cannot block the queue forever but a burst of calls or a
 * gateway outage never dead-letters it, stale entries expire, and the
 * dead-letter file stays bounded without dropping the letters just written.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MuninClient } from "../src/client";
import { MuninMaintenanceError } from "../src/errors";
import { keyFingerprint } from "../src/maintenance";
import {
  FAILURE_WINDOW_MS,
  MAX_FAILED_ATTEMPTS,
  MAX_PENDING_AGE_MS,
  MemoryWriteQueue,
  type PendingWrite,
} from "../src/writeQueue";
import { DEAD_LETTER_MAX_AGE_MS, DEAD_LETTER_MAX_BYTES, createFileWriteQueue } from "../src/node/fileWriteQueue";

const BASE_URL = "http://munin.test";
const JSON_HEADERS = { "Content-Type": "application/json" };
const MAINTENANCE_BODY = { ok: false, error: "MAINTENANCE_READ_ONLY", retryAfter: 900 };

type Answer = { status: number; body: unknown };
const OK: Answer = { status: 200, body: { ok: true } };
const MAINTENANCE: Answer = { status: 503, body: MAINTENANCE_BODY };
const SERVER_ERROR: Answer = { status: 500, body: { ok: false, error: "INTERNAL_ERROR" } };

function answering(answer: Answer | (() => Answer)) {
  const requests: Array<Record<string, any>> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const next = typeof answer === "function" ? answer() : answer;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: JSON_HEADERS });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function offline(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
}

async function entry(overrides: Partial<PendingWrite> = {}): Promise<PendingWrite> {
  return {
    id: globalThis.crypto.randomUUID(),
    queuedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    keyFingerprint: await keyFingerprint("key-a"),
    projectId: "p1",
    action: "store",
    payload: { key: "k", content: "c" },
    strippedKeys: [],
    ...overrides,
  };
}

function plainClient(fetchImpl: typeof fetch, writeQueue: MemoryWriteQueue | ReturnType<typeof createFileWriteQueue>) {
  return new MuninClient({ baseUrl: BASE_URL, apiKey: "key-a", fetchImpl, writeQueue, sleep: async () => {} });
}

async function queuedEntries(queue: MemoryWriteQueue): Promise<PendingWrite[]> {
  const seen: PendingWrite[] = [];
  await queue.drain(async (w) => { seen.push(w); return "keep"; });
  return seen;
}

async function strippedSecretsAreNeverADeadLetter() {
  // A client without rehydratePayload (the claude CLI, the session-start hook)
  // sends a queued write that carried encryptionKey: the server ignores
  // payload.encryptionKey on /api/mcp/action, so the stored payload is complete.
  const queue = new MemoryWriteQueue();
  await queue.enqueue(await entry({ strippedKeys: ["encryptionKey"] }));
  const { fetchImpl, requests } = answering(OK);
  const report = await plainClient(fetchImpl, queue).flushPendingWrites();
  assert.equal(report.sent, 1, "the queued write is sent");
  assert.equal(report.dead, 0, "never dead-lettered without a server answer");
  assert.equal(requests[0]?.payload.key, "k");
  assert.equal("encryptionKey" in requests[0].payload, false);

  // A rehydrator that has no key (MCP server without MUNIN_ENCRYPTION_KEY) also sends it.
  const second = new MemoryWriteQueue();
  await second.enqueue(await entry({ strippedKeys: ["encryptionKey"] }));
  const { fetchImpl: up, requests: sent } = answering(OK);
  const withNullRehydrator = new MuninClient({
    baseUrl: BASE_URL, apiKey: "key-a", fetchImpl: up, writeQueue: second, rehydratePayload: () => null,
  });
  assert.equal((await withNullRehydrator.flushPendingWrites()).sent, 1);
  assert.equal(sent.length, 1);
}

/** An entry whose backoff has run out, so the next pass sends it. */
function failedBefore(attempts: number, firstFailedMsAgo: number): Partial<PendingWrite> {
  const past = new Date(Date.now() - 1_000).toISOString();
  return {
    failedAttempts: attempts,
    firstFailedAt: new Date(Date.now() - firstFailedMsAgo).toISOString(),
    lastFailedAt: past,
    nextAttemptAt: past,
  };
}

async function failuresAreSpacedByBackoff() {
  // A burst of calls (every write flushes first) counts one failure, not one per call.
  const queue = new MemoryWriteQueue();
  await queue.enqueue(await entry());
  const { fetchImpl, requests } = answering(SERVER_ERROR);
  const c = plainClient(fetchImpl, queue);
  for (let i = 0; i < MAX_FAILED_ATTEMPTS * 2; i++) {
    assert.equal((await c.flushPendingWrites()).dead, 0, `burst call ${i} dead-letters nothing`);
  }
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    await assert.rejects(c.invoke("p1", "store", { key: `new-${i}` }), MuninMaintenanceError);
  }
  const [kept] = await queuedEntries(queue);
  assert.equal(kept.payload.key, "k", "the oldest write is still first");
  assert.equal(kept.failedAttempts, 1, "one failure per backoff interval");
  assert.ok(kept.lastFailedAt, "lastFailedAt recorded");
  assert.ok(Date.parse(String(kept.nextAttemptAt)) > Date.now(), "nextAttemptAt is in the future");
  assert.equal(requests.length, 1, "no request while the backoff runs");
  assert.equal(queue.deadLetters.length, 0);
}

async function failingEntryNeedsAttemptsAndTime() {
  // Enough attempts but still inside the window: kept.
  const early = new MemoryWriteQueue();
  await early.enqueue(await entry(failedBefore(MAX_FAILED_ATTEMPTS - 1, 60_000)));
  const { fetchImpl: failing } = answering(SERVER_ERROR);
  const first = await plainClient(failing, early).flushPendingWrites();
  assert.equal(first.dead, 0, "attempts alone do not dead-letter");
  assert.equal((await queuedEntries(early))[0].failedAttempts, MAX_FAILED_ATTEMPTS);

  // Past the window but few attempts: kept.
  const sparse = new MemoryWriteQueue();
  await sparse.enqueue(await entry(failedBefore(1, FAILURE_WINDOW_MS + 1_000)));
  assert.equal((await plainClient(failing, sparse).flushPendingWrites()).dead, 0, "time alone does not dead-letter");

  // Both: dead-lettered, and the queue moves on.
  const spent = new MemoryWriteQueue();
  await spent.enqueue(await entry(failedBefore(MAX_FAILED_ATTEMPTS - 1, FAILURE_WINDOW_MS + 1_000)));
  await spent.enqueue(await entry({ payload: { key: "next" } }));
  const { fetchImpl, requests } = answering(() => (requests.length === 1 ? SERVER_ERROR : OK));
  const c = plainClient(fetchImpl, spent);
  const report = await c.flushPendingWrites();
  assert.equal(report.dead, 1, `dead-lettered after ${MAX_FAILED_ATTEMPTS} attempts over the window`);
  assert.equal(report.sent, 1, "and the queue moves on");
  assert.equal(await spent.size(), 0);
  assert.equal(spent.deadLetters[0].deadReason, "failed");
  assert.equal(c.takeDeadLetterCount(), 1, "the client reports what it dead-lettered");
  assert.equal(c.takeDeadLetterCount(), 0, "once");
}

function answeringRaw(status: number, text: string, contentType: string) {
  const requests: number[] = [];
  const fetchImpl = (async () => {
    requests.push(status);
    return new Response(text, { status, headers: { "Content-Type": contentType } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

async function gatewayAnswersAreNotCounted() {
  // A reverse proxy answering while Munin restarts is like being offline.
  const gateways = [
    answeringRaw(502, "<html>502 Bad Gateway</html>", "text/html"),
    answeringRaw(504, "<html>504 Gateway Time-out</html>", "text/html"),
    answeringRaw(520, "error code: 520", "text/plain"),
    answeringRaw(503, JSON.stringify({ ok: false, error: "SERVICE_UNAVAILABLE" }), "application/json"),
    answeringRaw(500, "<html>Internal Server Error</html>", "text/html"),
    answeringRaw(500, "", "text/plain"),
  ];
  for (const { fetchImpl, requests } of gateways) {
    const queue = new MemoryWriteQueue();
    await queue.enqueue(await entry());
    const c = plainClient(fetchImpl, queue);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS * 2; i++) {
      await assert.rejects(c.invoke("p1", "store", { key: `new-${i}` }), MuninMaintenanceError);
    }
    const [kept] = await queuedEntries(queue);
    assert.equal(kept.payload.key, "k", `status ${requests[0]}: the freeze write is kept`);
    assert.equal(kept.failedAttempts ?? 0, 0, `status ${requests[0]}: not counted as a failure`);
    assert.equal(queue.deadLetters.length, 0, `status ${requests[0]}: nothing dead-lettered`);
  }
}

async function maintenanceAndTransportNeverDeadLetter() {
  const queue = new MemoryWriteQueue();
  await queue.enqueue(await entry());
  const { fetchImpl } = answering(MAINTENANCE);
  for (let i = 0; i < MAX_FAILED_ATTEMPTS * 2; i++) {
    assert.equal((await plainClient(fetchImpl, queue).flushPendingWrites()).dead, 0);
    assert.equal((await plainClient(offline(), queue).flushPendingWrites()).dead, 0);
  }
  const [kept] = await queuedEntries(queue);
  assert.equal(kept.failedAttempts ?? 0, 0, "maintenance and offline are not counted as failures");
}

async function writeBehindAFailingEntryIsNotCalledMaintenance() {
  const queue = new MemoryWriteQueue();
  await queue.enqueue(await entry());
  const { fetchImpl } = answering(SERVER_ERROR);
  await assert.rejects(plainClient(fetchImpl, queue).invoke("p1", "store", { key: "new" }), (error: unknown) => {
    assert.ok(error instanceof MuninMaintenanceError);
    assert.equal(error.queued, true);
    assert.doesNotMatch(error.message, /in maintenance/i, "not a false maintenance message");
    assert.match(error.message, /older/i);
    return true;
  });
}

async function staleEntriesExpire() {
  const queue = new MemoryWriteQueue();
  const queuedAt = new Date(Date.now() - MAX_PENDING_AGE_MS - 1_000).toISOString();
  await queue.enqueue(await entry({ queuedAt }));
  await queue.enqueue(await entry({ queuedAt, keyFingerprint: "someone-else" }));
  const { fetchImpl, requests } = answering(MAINTENANCE);
  const report = await plainClient(fetchImpl, queue).flushPendingWrites();
  assert.equal(report.expired, 2, "older than 24 h after queuedAt: expired, whoever owns it");
  assert.equal(report.dead, 2);
  assert.equal(requests.length, 0, "a stale write is never replayed");
  assert.equal(await queue.size(), 0);
  assert.deepEqual(queue.deadLetters.map((d) => d.deadReason), ["expired", "expired"]);
}

async function slowDrainDoesNotBlockEnqueue() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "munin-sdk-resilience-"));
  try {
    const drainer = createFileWriteQueue(dir);
    await drainer.enqueue(await entry({ payload: { key: "a" } }));
    await drainer.enqueue(await entry({ payload: { key: "b" } }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const firstRequest = new Promise<void>((resolve) => { started = resolve; });
    const sent: string[] = [];
    const slow = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      started();
      await gate;
      sent.push(String(JSON.parse(String(init?.body)).payload.key));
      return new Response(JSON.stringify(OK.body), { status: 200, headers: JSON_HEADERS });
    }) as typeof fetch;
    const draining = plainClient(slow, drainer).flushPendingWrites();
    await firstRequest;

    // Another process queues a write while the drain waits on the network.
    const other = createFileWriteQueue(dir);
    const t0 = Date.now();
    await other.enqueue(await entry({ payload: { key: "appended" } }));
    assert.ok(Date.now() - t0 < 1_000, `enqueue is not held behind network sends (took ${Date.now() - t0} ms)`);

    // A concurrent drain elsewhere does not send the same entries again.
    const { fetchImpl: up, requests } = answering(OK);
    const concurrent = await plainClient(up, other).flushPendingWrites();
    assert.equal(concurrent.sent, 0);
    assert.equal(requests.length, 0, "single drain across processes");

    release();
    const report = await draining;
    assert.equal(report.sent, 2);
    assert.deepEqual(sent, ["a", "b"]);
    const left: PendingWrite[] = [];
    await createFileWriteQueue(dir).drain(async (w) => { left.push(w); return "keep"; });
    assert.deepEqual(left.map((w) => w.payload.key), ["appended"], "the write appended meanwhile is kept");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function fileQueuePersistsFailureCounts() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "munin-sdk-resilience-"));
  try {
    await createFileWriteQueue(dir).enqueue(await entry());
    const { fetchImpl } = answering(SERVER_ERROR);
    await plainClient(fetchImpl, createFileWriteQueue(dir)).flushPendingWrites();
    const text = await fs.readFile(path.join(dir, "pending-writes.jsonl"), "utf8");
    const [stored] = text.trim().split("\n").map((line) => JSON.parse(line) as PendingWrite);
    assert.equal(stored.failedAttempts, 1, "a new process sees the failure count");
    assert.ok(stored.firstFailedAt);
    assert.ok(stored.lastFailedAt, "and when it last failed");
    assert.ok(Date.parse(String(stored.nextAttemptAt)) > Date.now(), "and when it may be sent again");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function deadLines(text: string): Array<Record<string, any>> {
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

async function deadLetterFileIsBounded() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "munin-sdk-resilience-"));
  const deadFile = path.join(dir, "pending-writes.dead.jsonl");
  try {
    const old = new Date(Date.now() - DEAD_LETTER_MAX_AGE_MS - 1_000).toISOString();
    const young = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(
      deadFile,
      `${JSON.stringify({ id: "ancient", deadAt: old, deadReason: "rejected" })}\n${JSON.stringify({ id: "older", deadAt: young, deadReason: "rejected" })}\n`,
      { mode: 0o600 },
    );
    const queue = createFileWriteQueue(dir);
    const big = "x".repeat(64 * 1024);
    const count = Math.ceil(DEAD_LETTER_MAX_BYTES / big.length) + 4;
    for (let i = 0; i < count; i++) await queue.enqueue(await entry({ payload: { key: `k${i}`, content: big } }));
    const rejected = { status: 400, body: { ok: false, error: "VALIDATION_ERROR" } };
    const { fetchImpl } = answering(rejected);
    const report = await plainClient(fetchImpl, queue).flushPendingWrites();
    assert.equal(report.dead, count);

    const stat = await fs.stat(deadFile);
    assert.equal(stat.mode & 0o777, 0o600);
    const lines = deadLines(await fs.readFile(deadFile, "utf8"));
    assert.equal(lines.some((l) => l.id === "ancient"), false, "entries older than the retention are pruned");
    assert.equal(lines.some((l) => l.id === "older"), false, "older lines make room for the new ones");
    assert.deepEqual(
      lines.map((l) => l.payload.key),
      Array.from({ length: count }, (_, i) => `k${i}`),
      "every letter of this call is written, even past the cap",
    );
    assert.equal(lines.at(-1)!.deadReason, "rejected");
    assert.ok(lines.at(-1)!.deadAt);

    // The next call prunes those older lines to fit the cap.
    await queue.enqueue(await entry({ payload: { key: "latest", content: "small" } }));
    await plainClient(answering(rejected).fetchImpl, queue).flushPendingWrites();
    const after = await fs.stat(deadFile);
    assert.ok(after.size <= DEAD_LETTER_MAX_BYTES, `dead-letter file capped (${after.size} bytes)`);
    const kept = deadLines(await fs.readFile(deadFile, "utf8"));
    assert.equal(kept.at(-1)!.payload.key, "latest", "the newest dead letter is kept");
    assert.equal(kept.at(-2)!.payload.key, `k${count - 1}`, "then the newest older ones");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function oversizedDeadLetterIsTruncatedNotDropped() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "munin-sdk-resilience-"));
  const deadFile = path.join(dir, "pending-writes.dead.jsonl");
  try {
    const queue = createFileWriteQueue(dir);
    const huge = "y".repeat(DEAD_LETTER_MAX_BYTES * 2);
    await queue.enqueue(await entry({ payload: { key: "huge", content: huge } }));
    const { fetchImpl } = answering({ status: 413, body: { ok: false, error: "PAYLOAD_TOO_LARGE" } });
    const client = plainClient(fetchImpl, queue);
    assert.equal((await client.flushPendingWrites()).dead, 1);
    const text = await fs.readFile(deadFile, "utf8");
    assert.ok(Buffer.byteLength(text) <= DEAD_LETTER_MAX_BYTES, `one letter fits the cap (${Buffer.byteLength(text)} bytes)`);
    const [letter] = deadLines(text);
    assert.equal(letter.payload.key, "huge", "the letter is written, not dropped");
    assert.equal(letter.truncated, true, "and marked truncated");
    assert.ok(letter.payload.content.length > 0 && letter.payload.content.length < huge.length);
    assert.equal(letter.deadReason, "rejected");
    assert.ok(letter.deadAt);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function run() {
  await strippedSecretsAreNeverADeadLetter();
  await failuresAreSpacedByBackoff();
  await failingEntryNeedsAttemptsAndTime();
  await gatewayAnswersAreNotCounted();
  await maintenanceAndTransportNeverDeadLetter();
  await writeBehindAFailingEntryIsNotCalledMaintenance();
  await staleEntriesExpire();
  await slowDrainDoesNotBlockEnqueue();
  await fileQueuePersistsFailureCounts();
  await deadLetterFileIsBounded();
  await oversizedDeadLetterIsTruncatedNotDropped();
  console.log("queue-resilience.test.ts: all cases passed");
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
