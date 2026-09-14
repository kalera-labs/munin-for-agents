# Munin AI Setup Guide

> **Version:** 1.0.0
> **Source:** [3d-era/munin-for-agents](https://github.com/kalera-labs/munin-for-agents)
> **Last Updated:** 2026-04-14

A step-by-step guide for AI agents to install and configure Munin — the persistent memory layer — using only the credentials provided by the user.

---

## Table of Contents

1. [What Is Munin?](#what-is-munin)
2. [Your Credentials](#your-credentials)
3. [Environment Variables — How They Work](#environment-variables--how-they-work)
4. [Smoke Test — Verify Before Installing Anything](#smoke-test--verify-before-installing-anything)
5. [Platform Setup](#platform-setup)
   - [Claude Code (Multi-project)](#claude-code-multi-project)
   - [OpenClaw / Hermes / MiniClaw (Single-project)](#openclaw--hermes--miniclaw-single-project)
   - [Gemini CLI](#gemini-cli)
   - [Cursor / Kilo / Qwen (MCP-native)](#cursor--kilo--qwen-mcp-native)
6. [Memory Index Protocol](#memory-index-protocol)
7. [MCP Tools Reference](#mcp-tools-reference)
8. [Temporal Validity Windows](#temporal-validity-windows)
9. [Search Query Best Practices — Hybrid 6-Signal Scoring](#search-query-best-practices--hybrid-6-signal-scoring)
10. [Auto-tagging Conventions](#auto-tagging-conventions)
11. [End-to-End Encryption (E2EE)](#end-to-end-encryption-e2ee)
12. [Error Recovery](#error-recovery)
13. [Update Workflow](#update-workflow)
14. [Quick Reference Card](#quick-reference-card)

---

## What Is Munin?

Munin is a **persistent memory layer for AI agents**. It gives your agent a long-term memory that survives across sessions — past tasks, decisions, bugs, architecture choices, and preferences are all remembered.

**Key features:**

- **Semantic search** — find memories using natural language
- **GraphRAG** — automatically builds a knowledge graph from stored memories
- **Error catalog** — remembers bugs and their fixes across sessions
- **E2EE** — end-to-end encryption so the server never sees your data
- **Cross-project sharing** — share memories between projects (Pro/Elite)

---

## Your Credentials

The user will provide these. You do not need to ask for them — the user will give them to you directly.

| Variable | Where to find | Format |
|---|---|---|
| `MUNIN_API_KEY` | [munin.kalera.app/dashboard](https://munin.kalera.app/dashboard) | `ck_xxx` |
| `MUNIN_PROJECT` | Same dashboard, under project settings | `proj_xxx` |
| `MUNIN_ENCRYPTION_KEY` | Only if project has E2EE enabled (set by user in WebUI) | user-defined password |

---

## Environment Variables — How They Work

**Read this before setting anything.**

### `MUNIN_PROJECT` — Per-project, walk-up supported

Can be set in (priority order):

1. Shell environment variable: `MUNIN_PROJECT=proj_xxx`
2. `.env.local` in your project directory
3. `.env` in your project directory
4. `~/.claude/settings.json` (deprecated — avoid)

Best way to set it:

```bash
munin-claude env set MUNIN_PROJECT proj_xxx
```

### `MUNIN_API_KEY` — Can now be set in `.env` too

Can be set in:

1. Shell environment: `MUNIN_API_KEY=ck_xxx`
2. `.env.local` in your project directory
3. `.env` in your project directory

> **Note:** You no longer need to export `MUNIN_API_KEY` to the shell. Setting it in `.env.local` or `.env` at the project root works automatically (the runtime walks up the directory tree to find it).

Best way to set it:

```bash
munin-claude env set MUNIN_API_KEY ck_xxx
# Or for per-project: add to .env.local in project root
```

### Quick verification

Run this to check both variables at once:

```bash
node -e "console.log('API_KEY:', !!process.env.MUNIN_API_KEY, '| PROJECT:', process.env.MUNIN_PROJECT || 'NOT SET')"
```

---

## Smoke Test — Verify Before Installing Anything

**Do this first.** It confirms your credentials work before you touch any plugin or config.

```bash
curl -X POST "https://munin.kalera.dev/api/mcp" \
  -H "Authorization: Bearer <user-provided-key>" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<user-provided-project>","action":"recent","payload":{}}'
```

**Expected output:**

```json
{ "ok": true, "encryptionEnabled": false, ... }
```

**Error meanings:**

| Output | Meaning | Fix |
|---|---|---|
| `{ "ok": true, ... }` | ✅ Credentials work | Proceed to platform setup |
| `401 Unauthorized` | ❌ Wrong API key | Ask user to re-copy from dashboard |
| `{ "ok": false, "error": "projectId is required" }` | ❌ No project ID | Set `MUNIN_PROJECT` in .env.local |
| `EAI_AGAIN` / network error | ❌ Cannot reach server | Check `MUNIN_BASE_URL` is correct |

**Do not proceed with plugin installation until the smoke test passes.**

---

## Platform Setup

### Claude Code (Multi-project)

Use this when Claude Code is working on a specific project directory and may need different memory projects for different codebases.

**Prerequisites:** Know the absolute path to the project directory you are working in. If `pwd` is not inside the project, `cd` to it first.

#### Step 1 — Set credentials in project `.env.local`

In the project root directory:

```bash
munin-claude env set MUNIN_API_KEY <user-provided-key>
munin-claude env set MUNIN_PROJECT <user-provided-project>
```

These are written to `.env.local` in the project root (not `.env`, so they won't be committed).

**Verify:**

```bash
munin-claude env get MUNIN_API_KEY  # should show non-empty
munin-claude env get MUNIN_PROJECT  # should show proj_xxx
```

#### Step 2 — Install the plugin

```bash
claude plugin marketplace add 3d-era/munin-for-agents
claude plugin install munin-claude-code@munin-ecosystem
```

**Verify:**

```bash
claude plugin list | grep munin
```

#### Step 3 — Update your CLAUDE.md

Fetch the latest agent instructions:

```bash
curl -s https://raw.githubusercontent.com/3d-era/munin-for-agents/main/agent-files/CLAUDE.md
```

Review the content and merge the **Memory Index Protocol** section into your project's `CLAUDE.md` if it doesn't already have it. If your project already has a `CLAUDE.md` with the Memory Index Protocol, skip this step.

#### Step 4 — Final smoke test

```bash
curl -X POST "https://munin.kalera.dev/api/mcp" \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<project>","action":"list","payload":{"limit":5}}'
```

Expected: `{ "ok": true, "data": [...] }` or `{ "ok": true, "data": [] }`

#### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MUNIN_API_KEY is required` | Not set anywhere | `munin-claude env set MUNIN_API_KEY <key>` |
| Empty list results | Wrong or missing project ID | `munin-claude env get MUNIN_PROJECT` — should show `proj_xxx` |
| Plugin not found | Not in project directory | `cd` to project root and retry |

---

### OpenClaw / Hermes / MiniClaw (Single-project)

Use this when the agent runs in a single-project context and shares one memory project across all sessions.

#### Step 1 — Install the plugin

```bash
openclaw plugins install @kalera/munin-openclaw
```

#### Step 2 — Configure credentials

```bash
openclaw config set plugins.entries.munin-openclaw.config.apiKey "<user-provided-key>"
openclaw config set plugins.entries.munin-openclaw.config.projectId "<user-provided-project>"
```

For E2EE projects, also set:

```bash
export MUNIN_ENCRYPTION_KEY="<user-provided-hash-key>"
```

#### Step 3 — Restart the agent

Restart OpenClaw/Hermes/MiniClaw to load the plugin.

#### Step 4 — Smoke test

```bash
openclaw exec munin-openclaw munin_list_memories
```

Expected: `{ "ok": true, "data": [...] }` or `{ "ok": true, "data": [] }`

#### Step 5 — Update agent config

If the agent has a `CLAUDE.md`-equivalent config file, add the **Memory Index Protocol** section from this guide.

---

### Gemini CLI

#### Step 1 — Install the extension

The extension is configured via `gemini-extension.json`. If not already present, create it at `~/.gemini/extensions/munin-extension.json`:

```json
{
  "name": "munin-memory",
  "version": "1.3.0",
  "args": ["-y", "@kalera/munin-gemini@latest", "mcp", "gemini-cli-extension"]
}
```

#### Step 2 — Set environment variables

Add to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
export MUNIN_API_KEY="<user-provided-key>"
export MUNIN_PROJECT="<user-provided-project>"
# For E2EE projects:
export MUNIN_ENCRYPTION_KEY="<user-provided-hash-key>"
```

Reload: `source ~/.zshrc` (or your chosen shell rc file).

#### Step 3 — Update GEMINI.md

Fetch the latest:

```bash
curl -s https://raw.githubusercontent.com/3d-era/munin-for-agents/main/agent-files/GEMINI.md
```

Merge the **Memory Index Protocol** into the agent's `GEMINI.md` if present.

#### Step 4 — Smoke test

```bash
curl -X POST "https://munin.kalera.dev/api/mcp" \
  -H "Content-Type: application/json" \
```

---

### Cursor / Kilo / Qwen (MCP-native)

These editors use MCP (Model Context Protocol) natively. Munin is available as `@kalera/munin-mcp-server`.

#### Step 1 — Add to MCP config

**For Cursor:** Add to `.cursor/mcp.json` (or via Cursor Settings → MCP):

```json
{
  "mcpServers": {
    "munin-memory": {
      "command": "npx",
      "args": ["-y", "@kalera/munin-mcp-server@latest"],
      "env": {
        "MUNIN_API_KEY": "<user-provided-key>",
        "MUNIN_PROJECT": "<user-provided-project>"
      }
    }
  }
}
```

> **Important:** For `MUNIN_PROJECT`, also create a `.env.local` or `.env` file in the workspace root so the server can resolve it when no explicit env is passed:
> ```
> MUNIN_PROJECT=<user-provided-project>
> ```

**For Kilo / Qwen:** Similar pattern — add to the platform's MCP config file, using the same `npx @kalera/munin-mcp-server@latest` command with env vars.

#### Step 2 — Update workspace CLAUDE.md

If the workspace has a `CLAUDE.md` or `CLAUDE.md` equivalent, add the **Memory Index Protocol** section.

#### Step 3 — Smoke test

Use the MCP tools panel (Cursor: Cmd+Shift+P → "MCP Tools") to run `munin_get_project_info`.

---

## Memory Index Protocol

These rules apply to **every task**, without exception.

### Rule 1 — At the Start of Every Task

Before doing anything, search for relevant memories:

```
munin_search_memories with keywords relevant to the current task
munin_retrieve_memory for detailed context on promising matches
```

**DO NOT guess.** Verify from memory first. If nothing relevant is found, proceed but note the gap.

### Rule 2 — At the End of Every Task

Store a memory capturing what was done:

```
munin_store_memory({
  title: "Brief summary of the task",
  content: "What changed, what decisions were made, file paths if relevant",
  tags: ["category", "subcategory"]
})
```

### Rule 3 — During Bug Fixing

Before attempting a fix, search for similar errors:

```
munin_search_memories with error keywords
```

If found in the error catalog, review the previous fix before attempting a new solution. After fixing, update the error catalog with the new resolution.

### Rule 4 — On Architectural Decisions

When making a significant decision:

```
munin_store_memory with tags: ["architecture", "decision"]
Include: what was decided, why, what alternatives were considered, date
```

### Rule 5 — Before `/compact`

Before running `/compact`, ensure all critical context from the session is stored:

```
munin_store_memory for any unwritten task outcomes or decisions
```

### Rule 6 — On Dependencies Change

When `package.json` or equivalent changes:

```
Update the `dependencies` memory block listing the new/changed packages
tags: ["dependencies"]
```

---

## MCP Tools Reference

| Tool | When to Use |
|---|---|
| `munin_search_memories` | Start of every task, semantic/keyword search (use quoted phrases + entity names for boost) |
| `munin_retrieve_memory` | Exact key known, need full content |
| `munin_list_memories` | Browse all memories, paginated |
| `munin_recent_memories` | Get latest N memories |
| `munin_store_memory` | End of task, bug fix, decision (set `validTo` for time-bound facts) |
| `munin_share_memory` | Share memories to another project (Pro/Elite) |
| `munin_versions` | View version history of a memory |
| `munin_rollback` | Rollback memory to a previous version |
| `munin_diff_memory` | Compare two versions of a memory |
| `munin_get_project_info` | Check E2EE status and tier |

**Important:** Always call these as MCP tools — never as shell commands.

---

## Temporal Validity Windows

Time-bound memories should set `validFrom` / `validTo` (ISO-8601). Search auto-filters out memories outside their validity window — no manual cleanup needed.

| Use case | validFrom | validTo |
|---|---|---|
| New policy effective Q3 | `2026-07-01` | omit |
| Sprint goal | omit | `2026-04-30` |
| Holiday promo | `2026-12-15` | `2026-12-25` |
| Permanent fact | omit | omit |

Search also accepts **temporal filters** in `filters.since` / `filters.before` (relative strings like `'last week'`, `'7 days ago'`):

```json
{
  "query": "incident postmortems",
  "filters": { "since": "last month" }
}
```

---

## Search Query Best Practices — Hybrid 6-Signal Scoring

Munin combines **keyword + semantic + 4 boosts** into a single relevance score:

| Signal | How to trigger from your query |
|---|---|
| Keyword exactness | Plain words match content/title |
| Semantic similarity | Natural-language query → embedding match |
| **Quoted phrase boost (+0.25)** | `"exact phrase in quotes"` matches doc literally |
| **Named-entity boost (+0.15)** | Capitalized words (people, products, places) found in doc |
| Recency boost (≤0.10) | Recent memories (≤7d) get bonus — auto |
| Pinned boost (+0.10) | `isPinned: true` memories — set at store time |

**Example queries:**

- ❌ Weak: `auth setup` → only semantic + keyword
- ✅ Strong: `"JWT TTL" Stripe Munin auth setup` → quoted phrase + 3 named entities

---

## Auto-tagging Conventions

Use these tags on every memory to keep the knowledge graph organized:

| Tag | When to Use |
|---|---|
| `task` | General task-related memories |
| `architecture` | Technical architecture, system design |
| `bug-fix` | Resolved bugs with root cause |
| `setup` | Configuration, environment setup |
| `decision` | Important decisions with rationale |
| `dependencies` | Library versions, package changes |
| `error-catalog` | Error patterns and their resolutions |
| `api` | API endpoints, request/response formats |
| `planning` | Feature plans, roadmaps |

---

## End-to-End Encryption (E2EE)

Munin supports **Zero-Knowledge Encryption**. When E2EE is enabled on a project, the server never sees your plaintext — you handle encryption locally.

### Check if E2EE is enabled

```bash
curl -X POST "https://munin.kalera.dev/api/mcp" \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<project>","action":"recent","payload":{}}'
```

Look for `encryptionEnabled: true` or `aiPoweredE2EE: true` in the response.

### Hash Key (Encryption Password)

Every E2EE project uses a **Hash Key** — a password set by the user in the Munin WebUI.

**Setup:**

```bash
munin-claude env set MUNIN_ENCRYPTION_KEY <user-provided-hash-key>
# Or add to project's .env.local:
echo 'MUNIN_ENCRYPTION_KEY=<hash-key>' >> .env.local
```

### Rules

- **Never log or output the Hash Key** in plain text
- **Never share the Hash Key** in chat or memory content
- **Never guess the Hash Key** — confirm with the user
- **Wrong key** → all reads and writes fail silently or return garbled content

### aiPoweredE2EE — GraphRAG + E2EE (Elite tier)

When `aiPoweredE2EE: true`:

- `munin_store_memory` payload **must** include an `embedding` field
- The embedding is a vector generated from the plaintext **client-side**, then the body is encrypted
- If the embedding is missing, the server returns HTTP 400

### Sharing Across Projects with E2EE

Memories can be shared via `munin_share_memory` (Pro/Elite). **The target project must share the same Hash Key** to read encrypted content. If the target has E2EE enabled and the key differs, the shared memory is unreadable until the user updates the target's Hash Key.

### Decryption Examples

When `encryptionMeta.enabled = true`, the `content` field is a Base64-encoded ciphertext. Here's how to decrypt it:

**Node.js:**

```javascript
const crypto = require('crypto');

const salt = Buffer.from(encryptionMeta.salt, 'base64');
const iv = Buffer.from(encryptionMeta.iv, 'base64');
const fullCiphertext = Buffer.from(memory.content, 'base64');

// Auth tag is the last 16 bytes (WebCrypto appends it)
const authTag = fullCiphertext.subarray(fullCiphertext.length - 16);
const actualCiphertext = fullCiphertext.subarray(0, fullCiphertext.length - 16);

const derivedKey = crypto.pbkdf2Sync(key, salt, 100000, 32, 'sha256');
const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
decipher.setAuthTag(authTag);

const plaintext = Buffer.concat([
  decipher.update(actualCiphertext),
  decipher.final()
]).toString('utf8');
```

**Python:**

```python
import base64, hashlib
from cryptography.hazmap.primitives.ciphers.aead import AESGCM

salt = base64.b64decode(encryptionMeta["salt"])
iv = base64.b64decode(encryptionMeta["iv"])
full_ciphertext = base64.b64decode(memory["content"])

derived_key = hashlib.pbkdf2_hmac('sha256', key.encode(), salt, 100000, dklen=32)
aesgcm = AESGCM(derived_key)
plaintext = aesgcm.decrypt(iv, full_ciphertext, None).decode('utf-8')
```

---

## Error Recovery

| Error Message | Cause | Fix |
|---|---|---|
| `MUNIN_API_KEY is required` | Not set anywhere | `munin-claude env set MUNIN_API_KEY <key>` |
| `401 Unauthorized` | Wrong API key | Ask user to re-copy from [dashboard](https://munin.kalera.app/dashboard) |
| `projectId is required` | No project context | `munin-claude env set MUNIN_PROJECT <project>` |
| `{ "ok": true, "data": [] }` | Empty — not an error | Project has no memories yet, which is normal for new setups |
| Silent empty results | Wrong or stale project ID | `munin-claude env get MUNIN_PROJECT` — confirm it matches dashboard |
| Decryption error | Wrong Hash Key | Confirm `MUNIN_ENCRYPTION_KEY` matches what user set in WebUI |
| E2EE content shows garbled text | Wrong Hash Key | Re-confirm the key with the user |
| `EAI_AGAIN` / network timeout | Server unreachable | Check `MUNIN_BASE_URL` — should be `https://munin.kalera.dev` |

---

## Update Workflow

When a new version of this guide is published:

1. Fetch the latest:
   ```bash
   curl -s https://raw.githubusercontent.com/3d-era/munin-for-agents/main/docs/ai-setup-guide.md
   ```
2. Review the **Changelog** section (if any)
3. Re-run the **Smoke Test** to verify credentials still work
4. Update your local `CLAUDE.md` / `GEMINI.md` with any new Memory Index Protocol rules

---

## Quick Reference Card

### Claude Code
```bash
munin-claude env set MUNIN_API_KEY <key>
munin-claude env set MUNIN_PROJECT <project>
claude plugin marketplace add 3d-era/munin-for-agents
claude plugin install munin-claude-code@munin-ecosystem
# Smoke test:
curl -X POST "https://munin.kalera.dev/api/mcp" \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<project>","action":"recent","payload":{}}'
```

### OpenClaw
```bash
openclaw plugins install @kalera/munin-openclaw
openclaw config set plugins.entries.munin-openclaw.config.apiKey "<key>"
openclaw config set plugins.entries.munin-openclaw.config.projectId "<project>"
# Smoke test:
openclaw exec munin-openclaw munin_list_memories
```

### Gemini CLI
```bash
# Add to shell profile:
export MUNIN_API_KEY="<key>"
export MUNIN_PROJECT="<project>"
# Smoke test:
curl -X POST "https://munin.kalera.dev/api/mcp" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<project>","action":"recent","payload":{}}'
```

### Cursor / MCP
```json
// .cursor/mcp.json
{
  "mcpServers": {
    "munin-memory": {
      "command": "npx",
      "args": ["-y", "@kalera/munin-mcp-server@latest"],
      "env": {
        "MUNIN_API_KEY": "<key>",
        "MUNIN_PROJECT": "<project>"
      }
    }
  }
}
```

---

*Munin — Steady like a turtle. 🐢*
