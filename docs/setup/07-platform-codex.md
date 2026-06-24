---
setupVersion: "2026-04-17"
audience: "llm-agent"
platform: "codex-cli"
loadOrder: 7
tokens: ~1400
---

# Platform Setup — OpenAI Codex CLI

End-to-end installation of the Munin memory layer for the OpenAI Codex CLI. Execute steps in order; each step has a verification gate.

**Prerequisites:**

- `codex` CLI installed and authenticated (`codex --version` succeeds).
- `MUNIN_API_KEY` (`ck_xxx`) and `MUNIN_PROJECT` (`proj_xxx`) provided by the user.

---

## Step 1 — Register the MCP server

Codex can spawn the Munin MCP server either through `npx` or through a globally installed
`munin-mcp-server` binary.

**Recommended default: `npx`**

This keeps setup small and avoids requiring a separate global install:

**macOS / Linux:**
```bash
codex mcp add munin-memory \
  -- npx -y @kalera/munin-mcp-server@latest
```

**Windows:** Codex cannot execute `npx` directly — wrap it with `cmd /c`:
```bash
codex mcp add munin-memory \
  -- cmd /c npx -y @kalera/munin-mcp-server@latest
```

Or edit `~/.codex/config.toml` manually:
```toml
[mcp.servers.munin-memory]
command = "cmd"
args = ["/c", "npx", "-y", "@kalera/munin-mcp-server@latest"]
```

This pattern was verified on **April 21, 2026** with:

- Codex CLI `v0.122.0`
- Node.js `v24.3.0`
- `codex exec` successfully completing `munin_get_project_info` over an MCP server launched by `npx`

**Alternative: global install**

If you want lower cold-start latency or a more deterministic local binary, install the package
globally and register the binary directly:

```bash
npm install -g @kalera/munin-mcp-server@latest

codex mcp add munin-memory \
  -- munin-mcp-server
```

Verify either setup with:

```bash
codex mcp list
# expect: munin-memory  ...  enabled
```

For E2EE projects, the server still needs `MUNIN_ENCRYPTION_KEY`, but keep it project-local in
`.env.local` alongside the project ID.

---

## Step 2 — Keep credentials per-project

**Do not set `MUNIN_API_KEY` or `MUNIN_PROJECT` in the global Codex MCP config.** Leave both out
of the global registration and resolve them from `.env.local` in each project. This makes project
switching explicit and lets users rotate credentials or point different repos at different Munin
projects without editing `~/.codex/config.toml`.

---

## Step 3 — Per-project `.env.local`

The MCP server inherits Codex's working directory and walks up the directory tree to find
`.env.local`. Create `.env.local` in each project root:

```bash
# .env.local  (one file per project root)
MUNIN_API_KEY=ck_your_api_key
MUNIN_PROJECT=proj_your_project_id
# E2EE only:
MUNIN_ENCRYPTION_KEY=your_hash_key
```

Add it to `.gitignore` if not already covered:

```bash
git check-ignore -v .env.local || echo '.env.local' >> .gitignore
```

This is the only per-project change needed. Switch projects by `cd`-ing to a different directory —
Codex picks up whichever `.env.local` is nearest the working directory.

> **Why this works:** `munin-runtime` calls `process.cwd()` at startup and walks up ancestor
directories looking for `.env.local`, then `.env`. Codex spawns the MCP server with the session
working directory as CWD, so each project naturally resolves its own `MUNIN_API_KEY`,
`MUNIN_PROJECT`, and optional `MUNIN_ENCRYPTION_KEY`.

---

## Step 4 — Allow MCP tool calls

By default, Codex requires user approval before each MCP tool call. In non-interactive (`exec`) mode this auto-cancels every call. Disable the elicitation gate globally:

```bash
# Append to ~/.codex/config.toml
cat >> ~/.codex/config.toml << 'EOF'

[features]
tool_call_mcp_elicitation = false
EOF
```

In **interactive mode** (running `codex` without `exec`), Codex presents an approval prompt per call — this is fine for interactive use and does not need the above change. Only apply the setting if you primarily use `codex exec`.

If you want a project review checklist for allowed Munin tools, validate the `munin-memory` server exposes this full set in the session tool list:

- `munin_search_memories`
- `munin_store_memory`
- `munin_retrieve_memory`
- `munin_recent_memories`
- `munin_list_memories`
- `munin_acknowledge_setup`
- `munin_share_memory`
- `munin_get_project_info`
- `munin_versions`
- `munin_rollback`
- `munin_diff_memory`
- `munin_delete_memory`

Do not disable the version-control or delete tools in Codex-specific policy if you want full Munin coverage in this project. `munin_delete_memory` is destructive, so keep normal human approval for actual delete operations.

---

## Step 5 — Verify

### Smoke test (direct HTTP — no Codex session needed)

```bash
curl -s -X POST "https://munin.kalera.dev/api/mcp" \
  -H "Authorization: Bearer <user-provided-key>" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<user-provided-project>","action":"recent","payload":{"limit":2}}'
```

Expected: `{"ok":true,"action":"recent","data":[...]}`. Any non-2xx or `"ok":false` — stop and fix credentials before continuing.

### MCP tool test (via Codex exec)

```bash
codex exec --dangerously-bypass-approvals-and-sandbox \
  "Call munin_get_project_info from the munin-memory MCP server and print the raw JSON."
```

Expected response shape:

```json
{
  "ok": true,
  "encryptionKeyConfigured": false,
  "specVersion": "v1.0.0",
  "actions": {
    "core": ["store", "store_batch", "retrieve", "search", "list", "recent"],
    "optional": ["share", "versions", "diff", "export", "rollback", "encrypt", "decrypt", "acknowledge_setup"]
  },
  "features": {
    "semanticSearch": { "supported": true },
    "encryption": { "supported": true }
  }
}
```

Then verify memory access:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox \
  "Call munin_recent_memories from munin-memory with limit 3 and print the result."
```

Expected: `{"ok":true,"data":[...]}` (empty array is fine for new projects).

---

## Step 6 — Update AGENTS.md

Codex reads agent instructions from `AGENTS.md` in the project root. Add the Memory Protocol pointer:

```markdown
## Memory Protocol (Munin)

Follow the Memory Index Protocol from:
https://raw.githubusercontent.com/3d-era/munin-for-agents/main/docs/setup/01-methodology.md
— call `munin_search_memories` at task start, `munin_store_memory` at task end.
```

If `AGENTS.md` does not exist, create it with just this section.

---

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `npx: command not found` | Node/npm toolchain not on PATH for Codex | Install Node.js and confirm `npx --version` works in the same shell that launches Codex |
| Windows: `npx` fails silently or MCP won't start | Bare `npx` not executable on Windows without a shell wrapper | Use `cmd /c npx ...` instead of `npx ...` (see Step 1 Windows note above) |
| `munin-mcp-server: command not found` | Using the global-binary path without installing it | `npm install -g @kalera/munin-mcp-server@latest`, or switch to the `npx` registration |
| `user cancelled MCP tool call` in exec mode | `tool_call_mcp_elicitation` is enabled | Add `[features] tool_call_mcp_elicitation = false` to `~/.codex/config.toml` |
| `MUNIN_API_KEY is required` | No project-local credential was found | Create `.env.local` with `MUNIN_API_KEY=ck_xxx` in the project root |
| `projectId is required` / empty results | No project-local project ID was found | Create `.env.local` with `MUNIN_PROJECT=proj_xxx` in the project root |
| Returns memories from wrong project | `codex` launched from wrong directory | `cd` to the project root before running `codex`; the MCP server walks up from CWD |
| `401 Unauthorized` | Wrong API key | Re-copy from [munin.kalera.app/dashboard](https://munin.kalera.app/dashboard) |
| Garbled content | E2EE project, wrong key | Re-add with `--env "MUNIN_ENCRYPTION_KEY=<hash-key>"` |
| `EAI_AGAIN` / network error | DNS/proxy issue | Confirm `MUNIN_BASE_URL` is unset or `https://munin.kalera.dev` |
| First startup feels slow | `npx` is fetching or resolving the package | Warm the cache once with `npx -y @kalera/munin-mcp-server@latest` or use the global-binary path |

---

*Next file: `01-methodology.md` — the memory protocol every agent must follow on every task.*
