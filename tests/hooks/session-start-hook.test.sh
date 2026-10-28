#!/usr/bin/env bash
# Offline test for both copies of the Claude Code plugin session-start hook:
# a fake `npx` records the CLI call, answers two memories, and the hook must
# (1) call the CLI with its real grammar `munin-claude <action> <payload-json>`
# and projectId in the payload, pinned to the release that flushes queued
# writes, (2) report the memory count, (3) mention writes still queued locally.
# Usage: bash munin-ecosystem/tests/hooks/session-start-hook.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HOOKS=(
  "$ROOT/munin-ecosystem/plugins/munin-claude-code/hooks/session-start-hook.sh"
  "$ROOT/apps/kalera-claude-code/plugins/munin-claude-code/hooks/session-start-hook.sh"
)
EXPECTED_PIN="@kalera/munin-claude@^1.6.0"
failures=0

fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

for hook in "${HOOKS[@]}"; do
  work="$(mktemp -d)"
  mkdir -p "$work/bin" "$work/project" "$work/queue"
  cat > "$work/bin/npx" <<'NPX'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$FAKE_NPX_ARGS"
echo '{"ok":true,"data":[{"key":"a"},{"key":"b"}]}'
NPX
  chmod +x "$work/bin/npx"
  printf 'MUNIN_PROJECT=proj_test\nMUNIN_API_KEY=test-key\n' > "$work/project/.env.local"

  # No queued writes: no maintenance notice.
  out="$(PATH="$work/bin:$PATH" FAKE_NPX_ARGS="$work/args" CLAUDE_PROJECT_DIR="$work/project" \
    MUNIN_QUEUE_DIR="$work/queue" HOME="$work" bash "$hook")"
  args="$(cat "$work/args")"
  expected_args="$(printf '%s\n' --yes "$EXPECTED_PIN" recent '{"projectId":"proj_test","limit":5}')"
  [[ "$args" == "$expected_args" ]] || fail "$hook: npx args were: $args"
  [[ "$out" == *"Loaded 2 recent memories"* ]] || fail "$hook: memory count missing in: $out"
  [[ "$out" != *"maintenance"* ]] || fail "$hook: unexpected maintenance notice: $out"

  # Two writes queued during a maintenance window: the notice says so.
  printf '{"id":"1"}\n{"id":"2"}\n' > "$work/queue/pending-writes.jsonl"
  out="$(PATH="$work/bin:$PATH" FAKE_NPX_ARGS="$work/args" CLAUDE_PROJECT_DIR="$work/project" \
    MUNIN_QUEUE_DIR="$work/queue" HOME="$work" bash "$hook")"
  [[ "$out" == *"2 memory write(s) are queued locally"* ]] || fail "$hook: pending notice missing in: $out"
  printf '%s' "$out" | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' \
    || fail "$hook: output is not valid JSON: $out"
  [[ "$out" != *"could not be delivered"* ]] || fail "$hook: unexpected dead-letter notice: $out"

  # Dead letters: only those from the last 24 h are reported.
  recent="$(node -e 'console.log(new Date(Date.now() - 3600e3).toISOString())')"
  old="$(node -e 'console.log(new Date(Date.now() - 3 * 86400e3).toISOString())')"
  printf '{"id":"d1","payload":{"note":"\\"deadAt\\":\\"9999\\""},"deadAt":"%s","deadReason":"failed"}\n{"id":"d2","deadAt":"%s","deadReason":"expired"}\n' \
    "$recent" "$old" > "$work/queue/pending-writes.dead.jsonl"
  out="$(PATH="$work/bin:$PATH" FAKE_NPX_ARGS="$work/args" CLAUDE_PROJECT_DIR="$work/project" \
    MUNIN_QUEUE_DIR="$work/queue" HOME="$work" bash "$hook")"
  [[ "$out" == *"1 queued memory write(s) could not be delivered"* ]] || fail "$hook: dead-letter notice missing in: $out"
  [[ "$out" == *"pending-writes.dead.jsonl"* ]] || fail "$hook: dead-letter file missing in: $out"
  printf '%s' "$out" | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' \
    || fail "$hook: output is not valid JSON: $out"

  rm -rf "$work"
done

if ! diff -q "${HOOKS[0]}" "${HOOKS[1]}" >/dev/null; then
  fail "the two hook copies differ"
fi

if [[ $failures -gt 0 ]]; then
  echo "session-start-hook tests: $failures failure(s)" >&2
  exit 1
fi
echo "session-start-hook tests passed"
