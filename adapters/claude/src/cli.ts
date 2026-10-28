#!/usr/bin/env node
import {
  executeWithRetry,
  loadCliEnv,
  parseCliArgs,
  safeError,
  startMcpServer,
  writeEnvFile,
} from "@kalera/munin-runtime";
import { createClaudeCodeMuninAdapter } from "./index.js";

/** How long the one-shot CLI may spend sending queued writes before it exits. */
const CLI_FLUSH_BUDGET_MS = 5_000;

async function main() {
  try {
    const args = process.argv.slice(2);

    // Start MCP server if requested or empty args
    if (args.length === 0 || args[0] === "mcp") {
      await startMcpServer();
      return;
    }

    // Handle env subcommands: munin-claude env <set|get> <key> [value]
    if (args[0] === "env") {
      const [, subcmd, key, ...rest] = args;

      const SUPPORTED_ENV_KEYS = ["MUNIN_API_KEY", "MUNIN_PROJECT", "MUNIN_ENCRYPTION_KEY"] as const;
      type SupportedEnvKey = (typeof SUPPORTED_ENV_KEYS)[number];
      const isSupportedKey = (k: string): k is SupportedEnvKey =>
        (SUPPORTED_ENV_KEYS as readonly string[]).includes(k);

      if (subcmd === "set") {
        if (!key) throw new Error("Usage: munin-claude env set <key> <value>");
        if (!isSupportedKey(key)) {
          throw new Error(`Unsupported key '${key}'. Supported: ${SUPPORTED_ENV_KEYS.join(", ")}`);
        }
        const value = rest.join(" ");
        if (!value) throw new Error("Usage: munin-claude env set <key> <value>");
        // Write to .env.local (gitignored by default) — never .env, which may be committed.
        writeEnvFile(".env.local", [{ key, value }]);
        console.log(JSON.stringify({ ok: true, message: `Set ${key} in .env.local` }));
        return;
      }

      if (subcmd === "get") {
        if (!key) throw new Error("Usage: munin-claude env get <key>");
        if (!isSupportedKey(key)) {
          throw new Error(`Unsupported key '${key}'. Supported: ${SUPPORTED_ENV_KEYS.join(", ")}`);
        }
        if (key === "MUNIN_PROJECT") {
          const { resolveProjectId } = await import("@kalera/munin-runtime");
          const projectId = resolveProjectId();
          console.log(JSON.stringify({ ok: true, key, value: projectId ?? null }));
          return;
        }
        // For MUNIN_API_KEY / MUNIN_ENCRYPTION_KEY — read via the runtime CLI env loader
        // so resolution order matches actual MCP server behavior:
        // shell env → .env.local (walked up) → .env (walked up).
        const { loadCliEnv } = await import("@kalera/munin-runtime");
        const env = loadCliEnv();
        const value =
          key === "MUNIN_API_KEY"
            ? env.apiKey ?? null
            : process.env.MUNIN_ENCRYPTION_KEY ?? null;
        console.log(JSON.stringify({ ok: true, key, value }));
        return;
      }

      throw new Error("Usage: munin-claude env <set|get> <key> [value]");
    }

    const { action, payload } = parseCliArgs(
      args,
      "Usage: munin-claude <action> [payload-json] OR munin-claude mcp OR munin-claude env <set|get>",
    );
    const env = loadCliEnv();

    const adapter = createClaudeCodeMuninAdapter({
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      timeoutMs: env.timeoutMs,
    });

    const result = await executeWithRetry(async () => {
      if (action === "capabilities") {
        return { ok: true, data: await adapter.capabilities() };
      }
      const { projectId, ...p } = payload;
      if (!projectId) throw new Error("projectId required in payload");
      return adapter.execute(projectId as string, action, p);
    }, env.retries, env.backoffMs);

    console.log(JSON.stringify(result, null, 2));
    // A one-shot CLI (the plugin's session-start hook runs it once per session)
    // exits right after this: let queued writes go out first, bounded. The
    // deadline also tightens a flush the SDK started after the call succeeded,
    // so the rest stays queued, in order, instead of holding the process open.
    await adapter.flushPendingWrites(Date.now() + CLI_FLUSH_BUDGET_MS).catch(() => undefined);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: safeError(error) }));
    process.exitCode = 1;
  }
}

void main();
