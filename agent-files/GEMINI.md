# Munin Claude Code Plugin — Gemini Extension

> **Full setup guide:** [docs/ai-setup-guide.md](https://github.com/kalera-labs/munin-for-agents/blob/main/docs/ai-setup-guide.md)
> **Quick reference:** [agent-files/SETUP.md](https://github.com/kalera-labs/munin-for-agents/blob/main/agent-files/SETUP.md)

This extension gives Gemini CLI persistent memory via Munin Context Core — memories survive across sessions, enabling semantic search, error catalogs, and GraphRAG.

---

## Memory Index Protocol (MANDATORY)

### 1. AT START OF EVERY NEW TASK (NON-NEGOTIABLE)
- Call `munin_search_memories` to scan for any relevant historical data (architecture, past fixes, dependencies).
- **Dependency Check**: Search for the `dependencies` tag to retrieve library versions without re-reading `package.json`.
- Use `munin_retrieve_memory` for full context if matches are found. **DO NOT GUESS** - verify everything from Munin.

### 2. AT END OF EVERY TASK (MANDATORY)
- Proactively summarize: Architectural decisions, new logic, or task outcomes.
- **Decision Versioning**: Explicitly state timelines or versions for major changes. This prevents using obsolete logic.
- **Code Anchoring**: Always include specific file paths and line numbers (e.g., `server/models/Project.ts:L45-50`).
- Use `munin_store_memory` to persist findings and build a robust Knowledge Graph.

### 3. DURING WORK & BUG FIXING
- **Error & Solution Catalog**: When a bug is fixed, immediately store a memory block containing: [Error Description/Stack Trace] + [Root Cause] + [Fixed Code Snippet (Anchoring)]. Use the `error-catalog` tag with relevant subsystem.
- If user provides critical info (preferences, IP, workflow), use `munin_store_memory` to pin it immediately.
- Do not wait for the end of the task for critical information.

### 4. PROJECT TAGGING & DEPENDENCY SYNC
- All memories MUST follow the tag format: `tags: ["category", "subcategory"]`.
- Update the `dependencies` memory block whenever `package.json` changes.

### 5. BEFORE EXECUTING /compact (MANDATORY)
- Ensure all critical context from the current session is stored via `munin_store_memory`.

### 6. MEMORY SEARCH
- Use `munin_search_memories` for semantic/content-based searches.
- Results include GraphRAG Entities and Relationships extracted automatically.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MUNIN_PROJECT` | *(required)* | Your project ID from munin.kalera.app |
| `MUNIN_BASE_URL` | `https://munin.kalera.dev` | Munin API server |
| `MUNIN_API_KEY` | *(from dashboard)* | API key for authentication |

**Best way to set:**

```bash
export MUNIN_API_KEY="<key>"
export MUNIN_PROJECT="<project>"
```

Both `MUNIN_API_KEY` and `MUNIN_PROJECT` can be set in `.env.local` at the project root — the runtime walks up the directory tree automatically. See [docs/ai-setup-guide.md](https://github.com/kalera-labs/munin-for-agents/blob/main/docs/ai-setup-guide.md) for details.

---

## Skill System

| Skill | Triggers | Description |
|-------|----------|-------------|
| `munin-memory` | "search memory", "remember", "find in memory" | Full memory operations |
| `munin-architecture` | "architecture", "tech stack", "system design" | Architecture context |
| `munin-error-catalog` | "bug", "error", "crash", "doesn't work" | Error resolution |
| `munin-projectid` | "/munin:projectid", "/projectid" | Set/check MUNIN_PROJECT |

---

## Plugin Structure

```
munin-claude-code/
├── .claude-plugin/plugin.json
├── .mcp.json              # MCP server config
├── hooks/                 # Session hooks
│   ├── session-start-hook.sh
│   ├── stop-hook.sh
│   ├── post-compact-hook.sh
│   └── error-catalog-hook.sh
└── skills/                # 4 specialized skills
```

For detailed setup instructions, E2EE guidance, and cross-platform setup, see **[docs/ai-setup-guide.md](https://github.com/kalera-labs/munin-for-agents/blob/main/docs/ai-setup-guide.md)**.
