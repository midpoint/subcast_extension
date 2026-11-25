#!/usr/bin/env bash
# Bump the extension version, run the checks, commit, tag, and push.
# Pushing the v* tag starts .github/workflows/release.yml, which builds the
# extension and publishes the zip to GitHub Releases.
#
# Usage:
#   ./scripts/release.sh patch            # 0.1.0 -> 0.1.1
#   ./scripts/release.sh minor            # 0.1.0 -> 0.2.0
#   ./scripts/release.sh major            # 0.1.0 -> 1.0.0
#   ./scripts/release.sh patch --dry-run  # checks + build, no version change
#   ./scripts/release.sh patch --yes      # skip the confirmation prompt
#   ./scripts/release.sh patch --no-push  # commit and tag locally only
#
# Override the remote with PUSH_URL=... if origin is not set (for example when
# GitHub is only reachable through a mirror).
set -euo pipefail

BUMP="${1:-}"
shift || true

DRY_RUN=false
ASSUME_YES=false
PUSH=true

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --yes|-y) ASSUME_YES=true ;;
    --no-push) PUSH=false ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

case "$BUMP" in
  patch|minor|major) ;;
  *)
    echo "Usage: $0 <patch|minor|major> [--dry-run] [--yes] [--no-push]" >&2
    exit 2
    ;;
esac

cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository." >&2
  exit 1
fi

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "Releases are cut from main; current branch is $(git rev-parse --abbrev-ref HEAD)." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "node_modules is missing. Run npm ci first." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean. Commit or stash your changes first:" >&2
  git status --short >&2
  exit 1
fi

CURRENT=$(node -p "require('./package.json').version")
NEXT=$(node -e '
  const [major, minor, patch] = process.argv[1].split(".").map(Number);
  const bump = process.argv[2];
  const next = bump === "major" ? [major + 1, 0, 0]
    : bump === "minor" ? [major, minor + 1, 0]
    : [major, minor, patch + 1];
  console.log(next.join("."));
' "$CURRENT" "$BUMP")
TAG="v$NEXT"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists." >&2
  exit 1
fi

echo "Current version: $CURRENT"
echo "Next version:    $NEXT ($TAG)"

echo
echo "Running type check, tests and production build..."
npx wxt prepare
npm run compile
npm test
npm run build

if $DRY_RUN; then
  echo
  echo "Dry run complete. No files were changed and no tag was pushed."
  exit 0
fi

if ! $ASSUME_YES; then
  echo
  read -r -p "Commit, tag $TAG and push? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

# The manifest version is taken from package.json by WXT, so verify the built
# artifact before publishing rather than trusting the config.
npm run build >/dev/null
VERSION="$VERSION" node -e '
  const manifest = require("./.output/chrome-mv3/manifest.json");
  if (manifest.version !== process.env.VERSION) {
    console.error(`manifest.json is ${manifest.version}, expected ${process.env.VERSION}`);
    process.exit(1);
  }
' 

git add package.json package-lock.json
git commit -m "Release $TAG"
git tag -a "$TAG" -m "SubCast Chrome extension $TAG"

if ! $PUSH; then
  echo
  echo "Committed and tagged $TAG locally. Push with:"
  echo "  git push origin main && git push origin $TAG"
  exit 0
fi

if [ -n "${PUSH_URL:-}" ]; then
  git push "$PUSH_URL" main
  git push "$PUSH_URL" "$TAG"
else
  if ! git remote get-url origin >/dev/null 2>&1; then
    echo "No origin remote. Add one, or rerun with PUSH_URL=..." >&2
    echo "Committed and tagged $TAG locally; nothing was pushed." >&2
    exit 1
  fi
  git push origin main
  git push origin "$TAG"
fi

echo
echo "Pushed $TAG. GitHub Actions is building and publishing the release:"
echo "  https://github.com/midpoint/subcast_extension/actions"
