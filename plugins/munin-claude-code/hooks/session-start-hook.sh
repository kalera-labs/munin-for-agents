#!/usr/bin/env bash
# Munin Session Start Hook — Loads project memories at session start
# Priority: 1. .env.local, 2. .env, 3. settings.json (deprecated, emits warning)

set -euo pipefail

# Resolve real script directory even when invoked through a symlink.
# Pure bash so it works on macOS (which lacks GNU `readlink -f`).
_SCRIPT="${BASH_SOURCE[0]}"
_HOPS=0
while [[ -L "$_SCRIPT" && $_HOPS -lt 40 ]]; do
  _DIR="$(cd -P "$(dirname "$_SCRIPT")" && pwd)"
  _SCRIPT="$(readlink "$_SCRIPT")"
  [[ "$_SCRIPT" != /* ]] && _SCRIPT="$_DIR/$_SCRIPT"
  _HOPS=$((_HOPS + 1))
done
SCRIPT_DIR="$(cd -P "$(dirname "$_SCRIPT")" && pwd)"
# Guard against a broken install (missing helper, symlink cycle resolving to a
# wrong directory). Emit a valid empty-context JSON so Claude Code still
# receives a parseable response rather than seeing the hook crash.
if [[ ! -f "$SCRIPT_DIR/lib/_env.sh" ]]; then
  echo '{"hookEventName":"SessionStart","additionalContext":""}'
  exit 0
fi
# shellcheck source=lib/_env.sh
. "$SCRIPT_DIR/lib/_env.sh"

CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MUNIN_PROJECT=""
MUNIN_API_KEY="${MUNIN_API_KEY:-}"

# --- Detect projectId (priority: .env.local > .env) ---
[[ -z "$MUNIN_PROJECT" ]] && MUNIN_PROJECT=$(read_env_var "$CLAUDE_PROJECT_DIR/.env.local" MUNIN_PROJECT)
[[ -z "$MUNIN_PROJECT" ]] && MUNIN_PROJECT=$(read_env_var "$CLAUDE_PROJECT_DIR/.env" MUNIN_PROJECT)

# --- Detect API key (priority: existing env > .env.local > .env) ---
[[ -z "$MUNIN_API_KEY" ]] && MUNIN_API_KEY=$(read_env_var "$CLAUDE_PROJECT_DIR/.env.local" MUNIN_API_KEY)
[[ -z "$MUNIN_API_KEY" ]] && MUNIN_API_KEY=$(read_env_var "$CLAUDE_PROJECT_DIR/.env" MUNIN_API_KEY)

# 3. Global settings.json (deprecated — emit warning but use for session)
if [[ -z "$MUNIN_PROJECT" && -f "$HOME/.claude/settings.json" ]]; then
  # Pass settings path via argv so values inside $HOME (e.g. an apostrophe)
  # cannot break the inline node script.
  SETTINGS_PROJECT=$(node -e "
    const fs = require('fs');
    try {
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      if (cfg.env && cfg.env.MUNIN_PROJECT) {
        console.log(cfg.env.MUNIN_PROJECT);
      } else if (cfg.MUNIN_PROJECT) {
        console.log(cfg.MUNIN_PROJECT);
      }
    } catch(e) {}
  " "$HOME/.claude/settings.json" 2>/dev/null || echo "")
  if [[ -n "$SETTINGS_PROJECT" ]]; then
    echo '[Munin 🐢] WARNING: MUNIN_PROJECT is set in ~/.claude/settings.json (global, deprecated for multi-project). Move it to project .env: run `munin-claude env set MUNIN_PROJECT '"$SETTINGS_PROJECT"'` then remove from settings.json.' >&2
    MUNIN_PROJECT="$SETTINGS_PROJECT"
  fi
fi

if [[ -z "$MUNIN_PROJECT" ]]; then
  echo '{"hookEventName":"SessionStart","additionalContext":""}'
  exit 0
fi

# --- Recent memories via the CLI: `munin-claude <action> <payload-json>`, with
# projectId in the payload. Pinned: >= 1.6.0 retries and flushes writes queued
# during a Munin maintenance window (Plan 1b Task 9); this read is the flush. ---
RECENT_PAYLOAD=$(printf '{"projectId":"%s","limit":5}' "$(json_escape "$MUNIN_PROJECT")")
SEARCH_RESULT=$(MUNIN_PROJECT="$MUNIN_PROJECT" MUNIN_API_KEY="$MUNIN_API_KEY" npx --yes @kalera/munin-claude@^1.6.0 recent "$RECENT_PAYLOAD" 2>/dev/null || echo '{}')

# Count "key" occurrences (one per memory). grep -o emits one line per match
# so wc -l counts occurrences, not lines — this matters because the upstream
# JSON is usually compact (all matches on one line). `|| true` prevents the
# pipefail trap from killing the script when grep finds zero matches.
MEMORY_COUNT=$(printf '%s' "$SEARCH_RESULT" | grep -o '"key"' | wc -l | tr -d ' ' || true)
[[ -z "$MEMORY_COUNT" || ! "$MEMORY_COUNT" =~ ^[0-9]+$ ]] && MEMORY_COUNT=0
PROJECT_NAME=$(basename "$CLAUDE_PROJECT_DIR")

CONTEXT="[Munin 🐢] Loaded $MEMORY_COUNT recent memories for '$PROJECT_NAME'. Use @kalera/munin to search deeper."

# Writes refused during a maintenance window wait here until the next
# successful call flushes them (the call above is one).
QUEUE_DIR="${MUNIN_QUEUE_DIR:-$HOME/.munin}"
PENDING_FILE="$QUEUE_DIR/pending-writes.jsonl"
PENDING_COUNT=0
[[ -f "$PENDING_FILE" ]] && PENDING_COUNT=$(grep -c . "$PENDING_FILE" 2>/dev/null || true)
[[ -z "$PENDING_COUNT" || ! "$PENDING_COUNT" =~ ^[0-9]+$ ]] && PENDING_COUNT=0
if [[ "$PENDING_COUNT" -gt 0 ]]; then
  CONTEXT="$CONTEXT Munin was in maintenance: $PENDING_COUNT memory write(s) are queued locally and will be retried automatically."
fi

# Queued writes the SDK gave up on (rejected, still failing, or older than
# 24 h) go to the dead-letter file; report those from the last 24 h. ISO
# timestamps compare as strings; the last "deadAt" of a line is the SDK's own.
DEAD_FILE="$QUEUE_DIR/pending-writes.dead.jsonl"
DEAD_COUNT=0
if [[ -f "$DEAD_FILE" ]]; then
  CUTOFF=$(date -u -v-24H +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null || true)
  DEAD_COUNT=$(sed -n 's/.*"deadAt":"\([^"]*\)".*/\1/p' "$DEAD_FILE" 2>/dev/null \
    | awk -v cutoff="$CUTOFF" '$0 >= cutoff { n++ } END { print n + 0 }' || true)
fi
[[ -z "$DEAD_COUNT" || ! "$DEAD_COUNT" =~ ^[0-9]+$ ]] && DEAD_COUNT=0
if [[ "$DEAD_COUNT" -gt 0 ]]; then
  CONTEXT="$CONTEXT $DEAD_COUNT queued memory write(s) could not be delivered in the last 24 h and were moved to $DEAD_FILE."
fi

printf '{"hookEventName":"SessionStart","additionalContext":"%s"}\n' "$(json_escape "$CONTEXT")"
