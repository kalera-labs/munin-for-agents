---
setupVersion: "2026-04-17"
audience: "llm-agent"
loadOrder: 1
tokens: ~1800
---

# Munin Setup — Entry Point

Munin = persistent memory for AI agents (semantic search via MCP tools).

This file is self-contained. 80% of agents complete setup using only this file plus the matching platform file.

---

## 1. Decision matrix — load exactly ONE platform file next

| Your platform                        | Read next                       |
|--------------------------------------|---------------------------------|
| Claude Code                          | `03-platform-claude-code.md`    |
| Cursor / Kilo / Qwen                 | `04-platform-cursor.md`         |
| Gemini CLI                           | `05-platform-gemini.md`         |
| OpenClaw / MiniClaw                  | `06-platform-openclaw.md`       |
| OpenAI Codex CLI                     | `07-platform-codex.md`          |
| Hermes Agent                         | `08-platform-hermes.md`         |
| OpenCode                             | `09-platform-opencode.md`       |
| Google Antigravity                   | `10-platform-antigravity.md`    |
| Other / generic MCP client           | `04-platform-cursor.md` (works for any MCP client) |

DO NOT load multiple platform files. DO NOT glob `docs/setup/*.md`. The decision matrix is deterministic — pick the row that matches.

---

## 2. Credentials

Three environment variables. The user provides them — do not invent values.

| Variable                | Required                       | Source                                      |
|-------------------------|--------------------------------|---------------------------------------------|
| `MUNIN_API_KEY`         | Always                         | `munin.kalera.app/dashboard` → `ck_xxx`     |
| `MUNIN_PROJECT`         | Always                         | Same dashboard, project settings → `proj_xxx` |
| `MUNIN_ENCRYPTION_KEY`  | Only if project has E2EE on    | User-defined password (set in WebUI)        |

> Domain split: `munin.kalera.dev` = MCP/REST API endpoint. `munin.kalera.app` = WebUI dashboard (where users get keys).

Resolution order (first non-empty wins): explicit MCP arg → shell env → `.env.local` (walked up) → `.env` (walked up).

**Verification (two stages — chicken-and-egg aware):**

1. **Bootstrap-only smoke test (BEFORE the platform plugin is installed):** A direct `curl -X POST https://munin.kalera.dev/api/mcp` is acceptable here to isolate credentials/network from MCP transport. Each platform file shows the exact `curl`. Pass = HTTP 2xx and `{ "ok": true, ... }`.
2. **Canonical post-install verification (AFTER the platform plugin is installed):** Call the MCP tool `munin_get_project_info`. Pass = `{ "ok": true, encryptionKeyConfigured: <boolean>, ... }` plus the server capability fields. This is the source of truth — once the plugin is installed, prefer the MCP tool over `curl`.

Anything else → `02-troubleshooting.md`.

---

## 3. MCP tool schemas (inline — authoritative)

These 8 schemas cover ~95% of agent usage. Match the JSON exactly when calling.

### `munin_search_memories` — call this FIRST in every task

```json
{
  "name": "munin_search_memories",
  "description": "Hybrid 6-signal search (keyword + semantic + named-entity + quoted-phrase + recency + pinned). Returns token-efficient GraphRAG context.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectId": { "type": "string" },
      "query":     { "type": "string" },
      "tags":      { "type": "array", "items": { "type": "string" } },
      "tagMode":   { "type": "string", "enum": ["or", "and"] },
      "filters":   {
        "type": "object",
        "properties": {
          "since":  { "type": "string", "description": "ISO date OR relative ('last week', '7 days ago')" },
          "before": { "type": "string" }
        }
      },
      "topK":         { "type": "number", "description": "default 10, max 50" },
      "offset":       { "type": "number" },
      "includeTotal": { "type": "boolean" }
    },
    "required": ["query"]
  }
}
```

### `munin_store_memory` — single OR batch (NEW: `memories` array, max 50)

```json
{
  "name": "munin_store_memory",
  "description": "Store one memory OR batch up to 50 in one call via `memories: [...]`. Batch mode drastically reduces API quota at session end / /compact.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectId": { "type": "string" },
      "key":       { "type": "string", "description": "Single mode: unique identifier" },
      "content":   { "type": "string", "description": "Single mode: the content" },
      "title":     { "type": "string" },
      "tags":      { "type": "array", "items": { "type": "string" } },
      "validFrom": { "type": "string", "description": "ISO-8601; hide before this date" },
      "validTo":   { "type": "string", "description": "ISO-8601; expire after this date" },
      "isPinned":  { "type": "boolean", "description": "Reserve for high-importance anchor facts" },
      "embedding": { "type": "array", "items": { "type": "number" }, "description": "REQUIRED only when project.aiPoweredE2EE=true (Elite tier with GraphRAG). Client generates 3072-dim vector from plaintext, then encrypts content. Otherwise omit — server generates server-side." },
      "encryptionMeta": { "type": "object", "description": "REQUIRED when project has E2EE enabled. Shape: { enabled, algorithm, iv, salt, authTag }." },
      "memories":  {
        "type": "array",
        "maxItems": 50,
        "description": "BATCH MODE. When provided, single-memory params are ignored. Per-item results returned in `data.results`.",
        "items": {
          "type": "object",
          "properties": {
            "key":       { "type": "string" },
            "content":   { "type": "string" },
            "title":     { "type": "string" },
            "tags":      { "type": "array", "items": { "type": "string" } },
            "validFrom": { "type": "string" },
            "validTo":   { "type": "string" },
            "isPinned":  { "type": "boolean" }
          },
          "required": ["key", "content"]
        }
      }
    },
    "required": []
  }
}
```

### `munin_retrieve_memory`

```json
{
  "name": "munin_retrieve_memory",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectId": { "type": "string" },
      "key":       { "type": "string" }
    },
    "required": ["key"]
  }
}
```

### `munin_recent_memories`

```json
{
  "name": "munin_recent_memories",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectId": { "type": "string" },
      "limit":     { "type": "number" }
    },
    "required": []
  }
}
```

### `munin_list_memories`

```json
{
  "name": "munin_list_memories",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectId": { "type": "string" },
      "limit":     { "type": "number", "description": "default 10, max 100" },
      "offset":    { "type": "number" }
    },
    "required": []
  }
}
```

### `munin_acknowledge_setup` — NEW (Phase C self-healing)

```json
{
  "name": "munin_acknowledge_setup",
  "description": "Call AFTER reading this index when server returns ERR_STALE_PROTOCOL. Subsequent writes proceed normally.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectId": { "type": "string" },
      "version":   { "type": "string", "description": "ISO date (YYYY-MM-DD), exactly as shown in remediation hint" }
    },
    "required": ["version"]
  }
}
```

### `munin_share_memory`

```json
{
  "name": "munin_share_memory",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectId":        { "type": "string" },
      "memoryIds":        { "type": "array", "items": { "type": "string" } },
      "targetProjectIds": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["memoryIds", "targetProjectIds"]
  }
}
```

### `munin_get_project_info`

```json
{
  "name": "munin_get_project_info",
  "description": "Returns server capabilities (specVersion, supported actions/features) and `encryptionKeyConfigured` flag (whether MUNIN_ENCRYPTION_KEY is set in the client's env). NOTE: capabilities are server-wide, not per-project. Per-project tier / E2EE status is NOT returned here — surface E2EE state to the user via observed write errors (e.g., 'Project requires encrypted memory content') or by asking the user directly.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectId": { "type": "string" }
    },
    "required": []
  }
}
```

### Version-control and destructive tools (rare flows)

```json
{ "name": "munin_versions",     "inputSchema": { "type": "object", "properties": { "projectId": {"type":"string"}, "key": {"type":"string"}, "id": {"type":"string"} }, "required": [] } }
{ "name": "munin_rollback",     "inputSchema": { "type": "object", "properties": { "projectId": {"type":"string"}, "key": {"type":"string"}, "id": {"type":"string"}, "version": {"type":"number"} }, "required": ["version"] } }
{ "name": "munin_diff_memory",  "inputSchema": { "type": "object", "properties": { "projectId": {"type":"string"}, "key": {"type":"string"}, "v1": {"type":"number"}, "v2": {"type":"number"} }, "required": ["key", "v1", "v2"] } }
{ "name": "munin_delete_memory","inputSchema": { "type": "object", "properties": { "projectId": {"type":"string"}, "key": {"type":"string"}, "id": {"type":"string"} }, "required": [] } }
```

For `munin_versions`, `munin_rollback`, and `munin_delete_memory`, pass exactly one of `key` or `id`. The mutual-exclusion rule is enforced at runtime instead of through top-level schema combinators so stricter MCP clients and providers can accept the tool definitions.

---

## 4. Anti-patterns — DO NOT do these

| ❌ Anti-pattern | Why it breaks | ✅ Do this instead |
|---|---|---|
| Greedy fetching (`glob docs/setup/*.md`) | Wastes context; loads files agent will never need | Load only files in section 1 decision matrix |
| Hallucinating tool params from naming | Schema mismatches cause silent failures | Read the JSON schema in section 3, copy field names exactly |
| Dumping a 5-paragraph narrative into one `store` call | Embedding loses focus; semantic search degrades | Atomic facts: 1 concept = 1 memory; long docs → file upload endpoint |
| Storing without searching first | Creates duplicates; pollutes the index | ALWAYS `munin_search_memories` BEFORE `munin_store_memory` |
| Calling MCP tools as shell commands | Wrong transport; will not execute | Always call as MCP tools through your platform's MCP client |

---

## 5. Setup acknowledgment (drift self-healing)

When the server returns HTTP 426 with `error: "ERR_STALE_PROTOCOL"`:

1. Re-read this file (`00-index.md`).
2. Re-read `01-methodology.md`.
3. Call `munin_acknowledge_setup({ version: "2026-04-17" })`.
4. Retry the original write call.

This is the only way to clear the stale-protocol flag. The server tracks acknowledgment per project.

---

## 6. Deeper references (PULL only when needed)

| File | When to load |
|---|---|
| `01-methodology.md` | Always — read on first connect for memory protocol, tagging, chunking, temporal validity, search tips |
| `02-troubleshooting.md` | Only when an error occurs |
| `99-changelog.md` | Only when reconciling old patterns or migrating |

Initial load order: `00-index.md` → matching platform file → `01-methodology.md`. Stop there until something fails.
