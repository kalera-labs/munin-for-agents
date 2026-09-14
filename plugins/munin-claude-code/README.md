# Munin for Claude Code

> **Munin** is a long-term memory system for developers. Every time you work with Claude Code, Munin remembers your context, decisions, bugs, and solutions — so you never have to repeat yourself.

**Munin** is your project's memory companion, integrated directly into Claude Code. It remembers your project, finds past errors, and suggests solutions based on what you've done before.

---

## Features

### 🤖 Munin Agent
Call `@munin` in any conversation to talk directly with your project's memory. Munin has full access to your memories — search, retrieve, store — all following the Memory Index Protocol.

### 🔍 Automatic Memory Search
Every time you start a Claude Code session, Munin automatically finds relevant memories from your project. No need to ask — context is already there.

### 💾 Session Summarization
When a session ends, Munin automatically saves a summary to memory. Tasks, decisions, bugs — everything is recorded.

### 📚 Error Catalog
When an error occurs, Munin will:
1. **Search** the error catalog first — a fix might already exist
2. **Fix** following the precedent
3. **Store** the new resolution so the next time is faster

### 🧠 GraphRAG Memory
Every memory is automatically indexed into a knowledge graph:
- **Entities** — services, libraries, models are extracted
- **Relationships** — connections between components are mapped
- **Semantic search** — find anything using natural language

---

## How It Works

```
You open Claude Code
        │
        ▼
  SessionStart Hook
  → Munin searches relevant memories
  → Context injected into conversation
        │
        ▼
  You work on your task
  → Munin monitors for errors
  → Errors → Error Catalog
        │
        ▼
  Session ends (or /compact)
  → Summary saved to memory
        │
        ▼
  Next session — Munin remembers
```

---

## Quick Start

### 1. Create a Free Munin Account

Sign up at [munin.kalera.app](https://munin.kalera.app) — FREE FOREVER.

After signing up, create a new project and copy your **Project ID** (`proj_xxxxxxxxxxxx`).

### 2. Add Credentials

Create `.env.local` in your project root (preferred — gitignored by default):

```bash
MUNIN_API_KEY=ck_your_api_key
MUNIN_PROJECT=proj_your_project_id
```

Both values come from your [Munin dashboard](https://munin.kalera.app/dashboard).

> **Use `.env.local`, not `.env`.** `.env` is typically committed to git and can leak your API key. The plugin reads both files, with `.env.local` taking priority, but credentials should always go in `.env.local`.
>
> If you use `munin-claude` CLI: `munin-claude env set MUNIN_API_KEY <key>` and `munin-claude env set MUNIN_PROJECT <project>` write to `.env.local` automatically.

### 3. Install via Plugin Marketplace

The easiest way — Claude Code handles everything automatically:

```bash
# Add the Munin plugin marketplace
/plugin marketplace add 3d-era/munin-for-agents

# Install the Munin plugin
/plugin install munin-claude-code@munin-ecosystem
```

That's it! Claude Code will pull the plugin directly from GitHub and set it up. To update later, run `/plugin update munin-claude-code@munin-ecosystem`.

**For development (from local repo):**
```bash
mkdir -p ~/.claude/plugins/marketplaces/munin/plugins
ln -sf /path/to/munin/munin-ecosystem/plugins/munin-claude-code \
  ~/.claude/plugins/marketplaces/munin/plugins/munin-claude-code
/plugin enable munin-claude-code@munin
```

### 4. Start Using

```bash
# Talk to Munin directly
@munion ask about the SePay integration
@munion what did we decide about the auth system?

# Or just start working — Munin auto-loads context
# Munin will remember everything when you finish
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MUNIN_PROJECT` | *(required)* | Your project ID from munin.kalera.app |
| `MUNIN_BASE_URL` | `https://munin.kalera.dev` | Munin API server |
| `MUNIN_API_KEY` | *(from dashboard)* | API key for authentication |

### Self-hosted Munin

If you're running your own Munin instance:

```bash
MUNIN_BASE_URL=https://your-munin-instance.com \
claude mcp add --scope user munin bash -c \
  'MUNIN_BASE_URL="https://your-munin-instance.com" exec npx @kalera/munin-claude mcp'
```

---

## Skills — What Triggers Munin

Munin activates automatically based on context:

| Skill | Triggers | What It Does |
|-------|----------|--------------|
| `munin-memory` | "search memory", "remember", "find in memory" | Full memory operations |
| `munin-architecture` | "architecture", "tech stack", "system design" | Architecture context |
| `munin-error-catalog` | "bug", "error", "crash", "doesn't work" | Error resolution |

---

## Memory Protocol — How Munin Works

### At Task Start
1. `munin_search_memories` with keywords relevant to the task
2. `munin_retrieve_memory` for detailed context
3. Present findings — **verify from memory, don't guess**

### At Task End
`munin_store_memory` with:
- **title**: Concise summary (max 80 chars)
- **content**: Details including file paths, decisions, outcomes
- **tags**: Categories (`task`, `architecture`, `bug-fix`, etc.)

### On Bug Fixes
1. Search error catalog first
2. Present existing fix if found
3. Fix and **store the new resolution**

### On Decisions
Tag as `architecture` + `decision`, include timeline/version

---

## Pricing

| Plan | Price | Memories | Projects |
|------|-------|----------|----------|
| **Free** | $0 | 500 | 3 |
| Pro | $9/mo | Unlimited | Unlimited |
| Team | $29/mo | Unlimited | Unlimited |

**[Sign up at munin.kalera.app →](https://munin.kalera.app)**

---

## Resources

| Resource | Link                                                                                           |
|----------|------------------------------------------------------------------------------------------------|
| 🌐 **Website** | [munin.kalera.app](https://munin.kalera.app)                                                   |
| 📖 **Docs** | [munin.kalera.app/docs](https://munin.kalera.app/docs)                                         |
| 💬 **Discord** | Coming soon                                                                                    |
| 🐛 **Issues** | [github.com/kalera-labs/munin-for-agents/issues](https://github.com/kalera-labs/munin-for-agents/issues) |
| 📦 **npm** | [npmjs.com/package/@kalera/munin-claude](https://npmjs.com/package/@kalera/munin-claude)       |
| 🔌 **Gemini Extension** | [github.com/kalera-labs/munin-gemini-extension](https://github.com/kalera-labs/munin-gemini-extension)   |

---

## License

MIT — [github.com/kalera-labs/munin-for-agents](https://github.com/kalera-labs/munin-for-agents)
