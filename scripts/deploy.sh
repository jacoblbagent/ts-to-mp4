#!/usr/bin/env bash
# Publish dist/ to the gh-pages branch.
#
# Zero npm dependencies on purpose: the `gh-pages` package pulls in
# globby > fast-glob > micromatch > braces, and `braces` carries an unfixed
# stack-exhaustion DoS advisory (GHSA-vfj7-8cjw-p6xm, no patched version as of
# 2026-09). Nothing here needs a globber, so the toolchain is dropped entirely.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BRANCH="${DEPLOY_BRANCH:-gh-pages}"
REMOTE="$(git remote get-url origin)"

# Use the gh CLI token when available so the push works without a preconfigured credential helper.
if command -v gh >/dev/null 2>&1 && TOKEN="$(gh auth token 2>/dev/null)" && [ -n "$TOKEN" ]; then
  REMOTE="$(printf '%s' "$REMOTE" | sed -E 's#^https://github.com/#https://x-access-token:'"$TOKEN"'@github.com/#')"
fi

NAME="$(git config user.name  || echo "deploy")"
EMAIL="$(git config user.email || echo "deploy@localhost")"

npm run build

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
# `cp -r dist/.` (not dist/*) so dotfiles such as .nojekyll come along.
cp -r dist/. "$BUILD_DIR/"

cd "$BUILD_DIR"
git init -q
git checkout -q -b "$BRANCH"
git -c user.name="$NAME" -c user.email="$EMAIL" add -A
git -c user.name="$NAME" -c user.email="$EMAIL" commit -q -m "Deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -q -f "$REMOTE" "$BRANCH"
echo "Published to $BRANCH ($(git rev-parse --short HEAD))"
