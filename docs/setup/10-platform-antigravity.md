---
setupVersion: "2026-04-17"
audience: "llm-agent"
platform: "antigravity"
loadOrder: 10
tokens: ~1500
---

# Platform Setup — Google Antigravity

End-to-end installation of the Munin memory layer for Google Antigravity. Execute steps in order; each step has a verification gate. Do not advance until verification passes.

**Prerequisites assumed satisfied** (from earlier docs in this set):

- `MUNIN_API_KEY` (`ck_xxx`) and `MUNIN_PROJECT` (`proj_xxx`) provided by the user.
- Smoke test against `https://munin.kalera.dev/api/mcp` already passed.
- Google Antigravity is active and loaded.

---

## Step 1 — Install Munin MCP server

The MCP server is published as `@kalera/munin-mcp-server` and is invoked via `npx` on demand. **No global install is needed** — `npx -y` fetches the latest version per spawn.

Optional warm-up (avoids first-spawn latency in the editor):

```bash
npx -y @kalera/munin-mcp-server@latest --version
```

Expected: prints a version string (e.g. `1.x.x`) and exits 0. Any non-zero exit means the package is unreachable — fix npm/network before continuing.

---

## Step 2 — Add to Google Antigravity MCP config

Google Antigravity reads its global MCP servers configuration from `~/.gemini/config/mcp_config.json`.

Update this file to include `munin-memory` in the `mcpServers` block:

```json
{
  "mcpServers": {
    "munin-memory": {
      "command": "npx",
      "args": ["-y", "@kalera/munin-mcp-server@latest"],
      "env": {
        "MUNIN_API_KEY": "<user-provided-key>",
        "MUNIN_PROJECT": "<user-provided-project>",
        "MUNIN_BASE_URL": "https://munin.kalera.dev"
      }
    }
  }
}
```

> [!TIP]
> Antigravity will automatically spawn the configured `npx` command as a long-lived MCP child process. The environment variables declared in the `env` block are passed down to the MCP server.

**Verify:**

Run a command to inspect `~/.gemini/config/mcp_config.json` and ensure the `munin-memory` key is present with correct command, args, and environment variables.

---

## Step 3 — Environment Variables & Local Fallbacks

Since Google Antigravity spawns MCP servers with the declared `env` block inside `mcp_config.json`, those take highest priority. However, you can also use a `.env.local` or `.env` file in your workspace directory to provide or override keys dynamically.

The MCP server resolution order is:
1. Explicit MCP `env` block in `mcp_config.json`
2. Parent process shell environment variables
3. Workspace-level `.env.local` (walked up from the workspace directory)
4. Workspace-level `.env` (walked up)

If you prefer to keep keys out of `mcp_config.json`, you can leave the `env` block in `mcp_config.json` empty (or omit it) and put the keys in `.env.local` in the project root:

```env
# .env.local
MUNIN_API_KEY=ck_xxx
MUNIN_PROJECT=proj_xxx
# If E2EE is enabled:
# MUNIN_ENCRYPTION_KEY=your-encryption-key
```

Make sure to add `.env.local` to `.gitignore`.

---

## Step 4 — Final Verification (Post-Install)

Once configured, verify that Google Antigravity can connect to the server and retrieve project information.

Call the MCP tool `munin_get_project_info` via the agent interface.

Expected output:

```json
{
  "ok": true,
  "encryptionKeyConfigured": false,
  "specVersion": "1.3.0",
  "capabilities": {
    "search": true,
    "store": true,
    "batch": true
  }
}
```

If the tool is missing or fails to execute, check Google Antigravity's logs or consult the troubleshooting guide (`02-troubleshooting.md`).
