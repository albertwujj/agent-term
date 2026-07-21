#!/bin/bash
set -euo pipefail

# Release script for AgentTerm.
# Usage:
#   ./scripts/release.sh            — bump patch version and publish a new release
#   ./scripts/release.sh --refresh  — rebuild and replace the current Windows installer
#   ./scripts/release.sh --patch-plugin /path/to/intellij-navigator-frontend-1.0.6.zip [tag]
# Requires: gh CLI, npm, node

REPO="yunxin/agent-term"
cd "$(git rev-parse --show-toplevel)"

CURRENT_VERSION=$(node -p "require('./package.json').version")

latest_release_asset() {
  local tag="$1"
  local pattern="$2"

  gh release view "$tag" --repo "$REPO" --json assets --jq '.assets[].name' \
    | grep -E "$pattern" \
    | sort -V \
    | tail -1
}

patch_plugin_asset() {
  local zip_path="$1"
  local tag="${2:-v${CURRENT_VERSION}}"
  local asset_name

  if [ ! -f "$zip_path" ]; then
    echo "Plugin zip not found: $zip_path" >&2
    exit 1
  fi

  asset_name="$(basename "$zip_path")"
  if [[ ! "$asset_name" =~ ^intellij-navigator(-frontend)?-[0-9].*\.zip$ ]]; then
    echo "Unexpected plugin asset name: $asset_name" >&2
    echo "Expected intellij-navigator-<version>.zip or intellij-navigator-frontend-<version>.zip" >&2
    exit 1
  fi

  echo "Patching ${asset_name} on release ${tag}..."
  gh release upload "$tag" "$zip_path" --repo "$REPO" --clobber

  echo ""
  echo "✅ ${tag}: https://github.com/${REPO}/releases/tag/${tag}"
}

if [ "${1:-}" = "--patch-plugin" ]; then
  if [ -z "${2:-}" ]; then
    echo "Usage: ./scripts/release.sh --patch-plugin /path/to/intellij-navigator-frontend-1.0.6.zip [tag]" >&2
    exit 1
  fi
  patch_plugin_asset "$2" "${3:-}"
  exit 0

elif [ "${1:-}" = "--refresh" ]; then
  # --- Refresh mode: rebuild and replace the Windows installer on existing release ---
  TAG="v${CURRENT_VERSION}"
  echo "Refreshing release ${TAG}..."

  echo "Building Windows x64..."
  npm run dist:win -- --x64

  # Replace .exe
  gh release delete-asset "$TAG" "AgentTerm-${CURRENT_VERSION}-setup.exe" --repo "$REPO" --yes 2>/dev/null || true
  gh release upload "$TAG" "release/AgentTerm-${CURRENT_VERSION}-setup.exe" --repo "$REPO"

  # Move tag to HEAD without deleting it remotely first.
  # Deleting the remote tag detaches the GitHub release and can hide its assets.
  git tag -f "$TAG"
  git push --force origin "refs/tags/${TAG}"

else
  # --- New release: bump patch version ---
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
  TAG="v${NEW_VERSION}"

  echo "Bumping version: ${CURRENT_VERSION} → ${NEW_VERSION}"
  npm version "$NEW_VERSION" --no-git-tag-version --quiet

  echo "Building Windows x64..."
  npm run dist:win -- --x64

  git add package.json package-lock.json
  git commit -m "Release ${TAG}"
  git tag "$TAG"
  git push origin main "$TAG"

  RELEASE_NOTES="## Assets

- **AgentTerm-${NEW_VERSION}-setup.exe** — Windows app that opens a WSL terminal automatically
- **intellij-navigator-<version>.zip** — IntelliJ/PyCharm backend plugin (file/symbol resolution)
- **intellij-navigator-frontend-<version>.zip** — IntelliJ/PyCharm frontend plugin (editor scroll/caret, read-only editor guard)

## IntelliJ/PyCharm Plugin Setup

In Remote Development (WSL) settings:

1. Select **Host** → **Settings → Plugins → ⚙ → Install Plugin from Disk** → install the latest \`intellij-navigator-<version>.zip\` asset on this release
2. Select **Client** → **Settings → Plugins → ⚙ → Install Plugin from Disk** → install the latest \`intellij-navigator-frontend-<version>.zip\` asset on this release

For a local (non-remote) IDE: install both zips into the same IDE via the same menu path."

  echo "Creating release ${TAG}..."
  gh release create "$TAG" \
    --repo "$REPO" \
    --title "AgentTerm ${TAG}" \
    --notes "$RELEASE_NOTES" \
    --latest \
    "release/AgentTerm-${NEW_VERSION}-setup.exe"

  # Carry forward the latest backend/frontend plugin zips from the previous release.
  PREV_TAG="v${CURRENT_VERSION}"
  BACKEND_ZIP=$(latest_release_asset "$PREV_TAG" '^intellij-navigator-[0-9].*\.zip$' || true)
  FRONTEND_ZIP=$(latest_release_asset "$PREV_TAG" '^intellij-navigator-frontend-[0-9].*\.zip$' || true)
  PLUGIN_ZIPS=()
  [ -n "${BACKEND_ZIP}" ] && PLUGIN_ZIPS+=("${BACKEND_ZIP}")
  [ -n "${FRONTEND_ZIP}" ] && PLUGIN_ZIPS+=("${FRONTEND_ZIP}")
  TMPDIR_PLUGINS=$(mktemp -d)
  trap 'rm -rf "$TMPDIR_PLUGINS"' EXIT

  for zip in "${PLUGIN_ZIPS[@]}"; do
    if [ -f "$zip" ]; then
      echo "Uploading local ${zip}..."
      gh release upload "$TAG" "$zip" --repo "$REPO"
    elif gh release download "$PREV_TAG" --repo "$REPO" --pattern "$zip" --dir "$TMPDIR_PLUGINS" 2>/dev/null; then
      echo "Carrying forward ${zip} from ${PREV_TAG}..."
      gh release upload "$TAG" "$TMPDIR_PLUGINS/$zip" --repo "$REPO"
    else
      echo "⚠ ${zip} not found locally or in ${PREV_TAG}"
    fi
  done
fi

# --- Clean up release directory ---
rm -rf release/AgentTerm-* release/win-unpacked release/builder-*.yml release/builder-*.yaml release/latest.yml

echo ""
echo "✅ ${TAG}: https://github.com/${REPO}/releases/tag/${TAG}"
