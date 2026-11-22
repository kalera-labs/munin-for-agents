---
setupVersion: "2026-04-17"
audience: "llm-agent"
loadOrder: 99
tokens: ~1750
---

# Munin Troubleshooting — Error → Fix Tables

Load this file ONLY when an operation fails. Do not pre-load. Find the error, apply the fix, retry.

---

## 1. HTTP status codes

| Status | Error string                  | Root cause                                              | Fix                                                                                  |
|--------|-------------------------------|---------------------------------------------------------|--------------------------------------------------------------------------------------|
| 401    | `Unauthorized`                | Wrong/missing `MUNIN_API_KEY`                           | Re-copy from `munin.kalera.app/dashboard`; ensure `ck_xxx` prefix                    |
| 403    | `API monthly limit reached for tier <X>` (or `API access is disabled for tier ...` / `Project not found or access denied`) | Free-tier monthly API quota exceeded, or project access denied | Wait for quota reset, or upgrade tier in dashboard                                  |
| 404    | `Project not found`           | Wrong `MUNIN_PROJECT`, or key belongs to a different user | Verify `proj_xxx` matches the dashboard for the user that owns the API key         |
| 426    | `ERR_STALE_PROTOCOL`          | Project's `setupVersion` is older than server's current version | See §1a: read `00-index.md`, call `munin_acknowledge_setup` with the version named in the error, retry the write |
| 426    | `ERR_CLIENT_OUTDATED`         | Munin client (SDK/plugin) is older than the server's minimum for writes | See §1b: update the client, restart the agent session, retry the write |
| 429    | `Rate limited`                | Too many requests in short window                       | Back off; batch via `memories: [...]` array on `munin_store_memory`                  |
| 500    | `Internal server error`       | Server-side issue                                       | Retry once; if persists check `https://status.munin.kalera.dev`                      |
| —      | `EAI_AGAIN` / `ETIMEDOUT`     | Network unreachable                                     | Verify `MUNIN_BASE_URL=https://munin.kalera.dev`; check DNS/firewall                 |

### 1a. `ERR_STALE_PROTOCOL` (HTTP 426 on a write)

The write was NOT saved. The error message names the acknowledged and required setup versions.

1. Read `https://raw.githubusercontent.com/kalera-labs/munin-for-agents/main/docs/setup/00-index.md`.
2. Call `munin_acknowledge_setup` with `{ "version": "<required version from the error>" }`.
3. Retry the write.

REST callers: the same data is in `remediation.acknowledge_after_reading.payload.version`.

### 1b. `ERR_CLIENT_OUTDATED` (HTTP 426 on a write)

The Munin client is older than the server's minimum, so the server refused the write. It was NOT saved. Reads are never blocked. `error.details` holds `client`, `version`, `minimum`, `latest` and `update` (commands).

| Client                         | Update                                                                                              |
|--------------------------------|-----------------------------------------------------------------------------------------------------|
| Claude Code                    | `npm install -g @kalera/munin-claude@latest && claude plugin update munin-claude-code`              |
| Other MCP configs              | `npx -y @kalera/munin-mcp-server@latest`                                                            |
| Python SDK (`munin-sdk-py`)    | `pip install -U munin-sdk-py` (needs the minimum version named in the error or newer)               |

Then restart the agent session (the old client stays loaded until restart) and retry the write.

Self-hosted servers: the floors come from `MUNIN_MIN_CLIENT_VERSION` (`@kalera/munin-sdk`, default `1.6.0`) and `MUNIN_MIN_PY_CLIENT_VERSION` (`munin-sdk-py`, default `0.2.0`). Set a value to `off` to disable that floor. `munin_get_project_info` shows the current floors under `clients`.

---

## 2. MCP-level errors (returned via the MCP transport)

| Error message                           | Cause                                  | Fix                                                                |
|-----------------------------------------|----------------------------------------|--------------------------------------------------------------------|
| `MUNIN_API_KEY is required`             | No key in env or `.env*` files         | Set `MUNIN_API_KEY` in shell or in `.env.local` at project root    |
| `projectId is required`                 | No `MUNIN_PROJECT` resolved            | Set `MUNIN_PROJECT` in `.env.local`, or pass `projectId` arg       |
| `requires exactly one of 'key' or 'id'` | Caller passed neither or both identifiers | Pass one identifier only: `key` or `id`, not both               |
| `Project not found or access denied`    | Wrong project ID OR API key for different user | Confirm the API key and project ID belong to the same dashboard user |
| `Unknown tool: <name>`                  | Tool name typo, or stale plugin        | Match name exactly to schema in `00-index.md`; reinstall plugin    |
| `ERR_STALE_PROTOCOL` / 426              | Setup version drift                    | See §1a: read setup, call `munin_acknowledge_setup`, retry         |
| `ERR_CLIENT_OUTDATED` / 426             | Munin client too old to write          | See §1b: update the client, restart the session, retry             |

---

## 3. Search problems

| Symptom                              | Likely cause                              | Fix                                                                                  |
|--------------------------------------|-------------------------------------------|--------------------------------------------------------------------------------------|
| `data: []` (empty results)           | Query too narrow, or wrong tag filter     | Drop `tags` filter; broaden query; try `munin_recent_memories` to confirm data exists |
| Memory was just stored but search returns nothing | E2EE key mismatch on read OR embedding fallback poisoned the index | Verify `MUNIN_ENCRYPTION_KEY` matches user's WebUI key; check server logs for `[EMBEDDING FALLBACK]` warnings — re-store affected memories after Gemini API recovers |
| Wrong/irrelevant top hits            | Query lacks boost signals                 | Add quoted phrase (`"..."`) and capitalized entity names; see `01-methodology.md` §5  |
| Results stale (no recent memories)   | `validTo` already expired                 | Re-store fact with extended `validTo`, or omit it for permanent facts                |
| Slow search (>1s)                    | Atlas Vector Search index missing/cold    | Production: confirm Atlas index exists; first query after deploy may be slow         |
| Single-word query returns noise      | No discriminative signal                  | Use 4–8 word query with quotes around the key term                                   |
| Results from wrong project           | `MUNIN_PROJECT` env mismatch              | `munin_get_project_info` to confirm active project                                   |

---

## 4. Store / batch problems

| Error                                                  | Cause                                          | Fix                                                                |
|--------------------------------------------------------|------------------------------------------------|--------------------------------------------------------------------|
| `memories array must contain at least one item`        | Empty `memories: []` in batch mode             | Either send single-memory params, or include ≥1 batch item        |
| `memories array exceeds maximum size of 50`            | More than 50 items in one call                 | Split into multiple batch calls                                    |
| `key and content are required`                         | Single-mode call missing required field        | Provide both `key` and `content`, OR switch to batch mode          |
| Embedding field missing (E2EE Elite)                   | `aiPoweredE2EE: true` requires client embedding | Generate embedding client-side from plaintext, send in `embedding` |
| Per-item failure inside batch                          | Partial failure                                | Inspect `data.results[].ok` and `data.results[].error` per item    |

---

## 5. Embedding fallback warnings

| Warning / error                                              | Meaning                                                  | Action                                                            |
|--------------------------------------------------------------|----------------------------------------------------------|-------------------------------------------------------------------|
| `Embedding fallback rate: X% (N samples)`                    | Gemini embedding API is rate-limited or failing; hash-based fallback in use | Reduce concurrency; check Gemini API quota; transient — retry  |
| `STRICT_EMBEDDING: fallback rate exceeded 5%, aborting`      | `STRICT_EMBEDDING=1` set; too many fallbacks → abort     | Investigate Gemini API status; unset `STRICT_EMBEDDING` to soft-fail |
| Search returns nonsense for newly-stored memories            | Memory stored with hash-fallback embedding                | Retry store after Gemini API recovers                             |

---

## 6. E2EE-specific problems

| Symptom                                | Cause                          | Fix                                                                |
|----------------------------------------|--------------------------------|--------------------------------------------------------------------|
| Garbled / unreadable `content`         | Wrong `MUNIN_ENCRYPTION_KEY`   | Re-confirm Hash Key with user; never guess                         |
| Shared memory unreadable in target project | Target project has different Hash Key | User must update target project Hash Key to match source       |
| HTTP 400 on store (Elite project)      | Missing client-side `embedding` field | Generate embedding from plaintext before encrypting body          |
| Hash Key visible in logs / output      | Anti-pattern — leaked secret   | Stop immediately; rotate Hash Key in WebUI; scrub logs             |

---

## 7. Version-control tools (rare flows)

When you need to reconcile or revert memories:

| Tool                  | Use case                                    | Required args                  |
|-----------------------|---------------------------------------------|--------------------------------|
| `munin_versions`      | List all versions of a memory               | `key`                          |
| `munin_rollback`      | Restore a memory to a previous version      | `key`, `version` (number)      |
| `munin_diff_memory`   | Compare two versions of the same memory     | `key`, `v1`, `v2`              |

Workflow: `munin_versions(key)` → identify the target version number → `munin_rollback(key, version)`.

---

## 8. When nothing else works

1. Run `munin_get_project_info` — returns server capabilities (specVersion, supported actions/features) and `encryptionKeyConfigured` (whether `MUNIN_ENCRYPTION_KEY` is set in the client's env). Per-project tier / E2EE flags are NOT returned here — confirm those with the user.
2. Run the bootstrap smoke-test `curl` from `00-index.md` §2 — bypasses MCP transport, isolates the network/auth layer. (After the platform plugin is installed, prefer `munin_get_project_info` over `curl`.)
3. Check `99-changelog.md` — your client may rely on a removed pattern.
4. Set `MUNIN_SKIP_SETUP_CHECK=1` (dev only) to bypass setup-version checks while debugging.
