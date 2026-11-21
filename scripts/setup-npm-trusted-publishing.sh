#!/usr/bin/env bash
# One-time setup: register GitHub Actions trusted publishing (OIDC) for every
# @kalera package this repository publishes, so CI publishes without a token.
#
# Run it yourself, in an interactive terminal, logged in to npm as an owner of
# the @kalera packages (`npm login`). npm asks for 2FA on each package: `npm
# trust` refuses bypass-2FA tokens by design.
#
# Usage: scripts/setup-npm-trusted-publishing.sh [--dry-run]
#
# A new trust configuration expires if no publish succeeds through it within
# 2 days, so run the Release workflow soon after this script.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

REPO="kalera-labs/munin-for-agents"
ENVIRONMENT="npm-release"
NPM_CLI="npm@12.2.3" # `npm trust` needs npm >= 11.15.0
DRY_RUN="${1:-}"

npm_cli() { npx --yes "$NPM_CLI" "$@"; }

if ! user="$(npm_cli whoami 2>/dev/null)"; then
  echo "Not logged in to npm. Run: npm login" >&2
  exit 1
fi
echo "npm user: ${user}"

trust() { # <package> <workflow file>
  echo "== $1 <- ${REPO} .github/workflows/$2 (environment ${ENVIRONMENT})"
  npm_cli trust github "$1" --repo "$REPO" --file "$2" \
    --env "$ENVIRONMENT" --allow-publish --yes ${DRY_RUN:+"$DRY_RUN"}
}

for dir in packages/* adapters/*; do
  [ -f "$dir/package.json" ] || continue
  if [ "$(node -p "require('./$dir/package.json').private === true")" = "true" ]; then
    continue
  fi
  trust "$(node -p "require('./$dir/package.json').name")" release.yml
done

trust "@kalera/munin-claude-plugin" plugin-release.yml

echo "Done. Now run the Release workflow, then push the plugin-claude-v* tag."
