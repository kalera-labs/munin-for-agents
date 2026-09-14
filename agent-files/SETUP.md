# Munin Setup Reference

> For full step-by-step setup instructions, see: **[docs/ai-setup-guide.md](https://github.com/kalera-labs/munin-for-agents/blob/main/docs/ai-setup-guide.md)**

---

## What Is Munin?

Persistent memory layer for AI agents — semantic search, error catalog, GraphRAG, E2EE, cross-project sharing. See the full guide for details.

---

## Credentials

Ask the user for:

| Variable | Where |
|---|---|
| `MUNIN_API_KEY` | [munin.kalera.app/dashboard](https://munin.kalera.app/dashboard) |
| `MUNIN_PROJECT` | Same dashboard (`proj_xxx` format) |
| `MUNIN_ENCRYPTION_KEY` | Only if E2EE enabled (set in WebUI) |

---

## Environment Variables

| Variable | Config Location | Notes |
|---|---|---|
| `MUNIN_API_KEY` | `.env.local`, `.env`, or shell | Walked up automatically |
| `MUNIN_PROJECT` | `.env.local`, `.env` | Per-project |
| `MUNIN_BASE_URL` | Shell | Defaults to `https://munin.kalera.dev` |
| `MUNIN_ENCRYPTION_KEY` | `.env.local` | Per-project, E2EE only |

**Best way to set:**

```bash
munin-claude env set MUNIN_API_KEY <key>
munin-claude env set MUNIN_PROJECT <project>
```

---

## Smoke Test (Always Do This First)

```bash
MUNIN_API_KEY="<key>" MUNIN_PROJECT="<project>" \
npx --yes @kalera/munin-claude call munin_get_project_info '{}'
```

Expected: `{ "ok": true, ... }`

| Error | Meaning | Fix |
|---|---|---|
| `401 Unauthorized` | Wrong API key | Re-copy from dashboard |
| `projectId required` | Missing project ID | Set `MUNIN_PROJECT` |
| `{ "ok": true, "data": [] }` | ✅ Works, no memories yet | Normal for new projects |

---

## Quick Setup Per Platform

### Claude Code
```bash
munin-claude env set MUNIN_API_KEY <key>
munin-claude env set MUNIN_PROJECT <project>
claude plugin marketplace add 3d-era/munin-for-agents
claude plugin install munin-claude-code@munin-ecosystem
```

### OpenClaw
```bash
openclaw plugins install @kalera/munin-openclaw
openclaw config set plugins.entries.munin-openclaw.config.apiKey "<key>"
openclaw config set plugins.entries.munin-openclaw.config.projectId "<project>"
```

### Cursor / MCP-native
Add to `.cursor/mcp.json`:
```json
{ "command": "npx", "args": ["-y", "@kalera/munin-mcp-server@latest"],
  "env": { "MUNIN_API_KEY": "<key>", "MUNIN_PROJECT": "<project>" } }
```

---

## Memory Index Protocol

1. **AT START** → `munin_search_memories` (never guess)
2. **AT END** → `munin_store_memory` (title/content/tags)
3. **ON BUG** → check error catalog → fix → store resolution
4. **ON DECISION** → store with `["architecture", "decision"]` tags + timeline
5. **BEFORE `/compact`** → store all unwritten context
6. **ON DEPENDENCIES CHANGE** → update `["dependencies"]` memory block

---

## Tags

`task` · `architecture` · `bug-fix` · `setup` · `decision` · `dependencies` · `error-catalog` · `api` · `planning`

---

## MCP Tools

`munin_search_memories` · `munin_retrieve_memory` · `munin_list_memories` · `munin_recent_memories` · `munin_store_memory` · `munin_share_memory` · `munin_versions` · `munin_rollback` · `munin_diff_memory` · `munin_get_project_info`

Always call as MCP tools — never as shell commands.

---

*Full guide: [docs/ai-setup-guide.md](https://github.com/kalera-labs/munin-for-agents/blob/main/docs/ai-setup-guide.md)*
