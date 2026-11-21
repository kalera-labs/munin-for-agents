#!/usr/bin/env bash
# Publish one package to npm through trusted publishing (OIDC). No npm token is
# read: the job needs `id-token: write` and a trusted publisher on npmjs.com
# that names this repository, the calling workflow file and its environment.
#
# Usage: npm-publish-oidc.sh <package-dir> [--pnpm-pack]
#   --pnpm-pack  pack with pnpm first, so `workspace:*` ranges become real
#                versions, then publish the tarball with the npm CLI.
#
# Exits 0 when the version is published now or is already on the registry,
# so a re-run of a partly failed release is safe.
set -euo pipefail

dir="$1"
mode="${2:-}"

npm_version="$(npm --version)"
if ! node -e '
  const [a, b, c] = process.argv[1].split(".").map(Number);
  process.exit(a > 11 || (a === 11 && (b > 5 || (b === 5 && c >= 1))) ? 0 : 1);
' "$npm_version"; then
  echo "::error::npm ${npm_version} cannot use trusted publishing (needs >= 11.5.1)"
  exit 1
fi

manifest="$(cd "$dir" && pwd)/package.json"
name="$(node -p 'require(process.argv[1]).name' "$manifest")"
version="$(node -p 'require(process.argv[1]).version' "$manifest")"

if npm view "${name}@${version}" version >/dev/null 2>&1; then
  echo "::notice::${name}@${version} is already on npm, skipping"
  exit 0
fi

target="$dir"
if [ "$mode" = "--pnpm-pack" ]; then
  out="$(mktemp -d)"
  pnpm -C "$dir" pack --pack-destination "$out" >/dev/null
  target="$(ls "$out"/*.tgz)"
fi

echo "Publishing ${name}@${version}"
npm publish "$target" --access public
