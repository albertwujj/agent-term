#!/bin/bash
set -euo pipefail

# Plugin-only release script for AgentTerm.
# Usage:
#   ./scripts/release.sh             — verify, bump patch, and publish a plugin-only release
#   ./scripts/release.sh --check     — run the same read-only release checks without publishing
#   ./scripts/release.sh --patch-plugin /path/to/intellij-navigator-frontend-1.0.16.zip [tag]
#
# The Windows installer publishing path is retired. Its last-known procedure is
# preserved in WINDOWS_INSTALLER.md.
# Requires: gh CLI, npm, node, unzip

REPO="albertwujj/agent-term"
cd "$(git rev-parse --show-toplevel)"

CURRENT_VERSION=$(node -p "require('./package.json').version")
PLUGIN_TMP_DIR=""

cleanup() {
  if [ -n "$PLUGIN_TMP_DIR" ] && [ -d "$PLUGIN_TMP_DIR" ]; then
    rm -rf "$PLUGIN_TMP_DIR"
  fi
}
trap cleanup EXIT

die() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage:
  ./scripts/release.sh
  ./scripts/release.sh --check
  ./scripts/release.sh --patch-plugin /path/to/intellij-navigator-<version>.zip [tag]

Windows installer publishing is retired; see WINDOWS_INSTALLER.md for the frozen history.
EOF
  exit 1
}

require_commands() {
  local command_name
  for command_name in git gh npm node unzip; do
    command -v "$command_name" >/dev/null 2>&1 || die "Required command not found: $command_name"
  done
}

require_clean_main() {
  [ "$(git branch --show-current)" = "main" ] || die "Releases must be created from main."
  [ -z "$(git status --porcelain)" ] || die "The worktree must be clean before releasing."

  echo "Checking origin/main..."
  git fetch origin main --quiet
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
    || die "Local main must exactly match origin/main before releasing."
}

latest_release_asset() {
  local tag="$1"
  local pattern="$2"

  gh release view "$tag" --repo "$REPO" --json assets --jq '.assets[].name' \
    | grep -E "$pattern" \
    | sort -V \
    | tail -1
}

download_plugin_assets() {
  local source_tag="$1"
  local backend_zip
  local frontend_zip

  backend_zip=$(latest_release_asset "$source_tag" '^intellij-navigator-[0-9].*\.zip$' || true)
  frontend_zip=$(latest_release_asset "$source_tag" '^intellij-navigator-frontend-[0-9].*\.zip$' || true)

  [ -n "$backend_zip" ] || die "No backend IDE plugin ZIP found on ${source_tag}."
  [ -n "$frontend_zip" ] || die "No frontend IDE plugin ZIP found on ${source_tag}."

  PLUGIN_TMP_DIR=$(mktemp -d)
  echo "Downloading plugin assets from ${source_tag}..."
  gh release download "$source_tag" --repo "$REPO" --pattern "$backend_zip" --dir "$PLUGIN_TMP_DIR"
  gh release download "$source_tag" --repo "$REPO" --pattern "$frontend_zip" --dir "$PLUGIN_TMP_DIR"

  unzip -tq "$PLUGIN_TMP_DIR/$backend_zip" >/dev/null
  unzip -tq "$PLUGIN_TMP_DIR/$frontend_zip" >/dev/null

  BACKEND_ZIP="$backend_zip"
  FRONTEND_ZIP="$frontend_zip"
}

patch_plugin_asset() {
  local zip_path="$1"
  local tag="${2:-v${CURRENT_VERSION}}"
  local asset_name
  local family_pattern
  local existing_asset

  [ -f "$zip_path" ] || die "Plugin ZIP not found: $zip_path"

  asset_name="$(basename "$zip_path")"
  if [[ "$asset_name" =~ ^intellij-navigator-frontend-[0-9].*\.zip$ ]]; then
    family_pattern='^intellij-navigator-frontend-[0-9].*\.zip$'
  elif [[ "$asset_name" =~ ^intellij-navigator-[0-9].*\.zip$ ]]; then
    family_pattern='^intellij-navigator-[0-9].*\.zip$'
  else
    die "Unexpected plugin asset name: ${asset_name}. Expected intellij-navigator-<version>.zip or intellij-navigator-frontend-<version>.zip."
  fi

  unzip -tq "$zip_path" >/dev/null || die "Plugin asset is not a valid ZIP: $zip_path"

  echo "Uploading ${asset_name} to ${tag}..."
  gh release upload "$tag" "$zip_path" --repo "$REPO" --clobber

  # Keep one current ZIP for this half of the JetBrains plugin. Upload first so
  # a failed upload can never leave the release without a usable asset.
  while IFS= read -r existing_asset; do
    if [ -n "$existing_asset" ] && [ "$existing_asset" != "$asset_name" ]; then
      echo "Removing superseded ${existing_asset}..."
      gh release delete-asset "$tag" "$existing_asset" --repo "$REPO" --yes
    fi
  done < <(
    gh release view "$tag" --repo "$REPO" --json assets --jq '.assets[].name' \
      | grep -E "$family_pattern" || true
  )

  echo ""
  echo "✅ ${tag}: https://github.com/${REPO}/releases/tag/${tag}"
}

case "${1:-}" in
  --patch-plugin)
    [ -n "${2:-}" ] || usage
    [ -z "${4:-}" ] || usage
    require_commands
    patch_plugin_asset "$2" "${3:-}"
    exit 0
    ;;
  --refresh)
    die "Windows installer refreshes are retired. Releases now contain IDE plugins only; see WINDOWS_INSTALLER.md for the frozen installer history."
    ;;
  --check|"")
    ;;
  *)
    usage
    ;;
esac

require_commands
require_clean_main

if [[ ! "$CURRENT_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  die "package.json version is not a simple semantic version: $CURRENT_VERSION"
fi

NEW_VERSION="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"
PREV_TAG="v${CURRENT_VERSION}"
TAG="v${NEW_VERSION}"

git rev-parse --verify --quiet "refs/tags/${TAG}" >/dev/null \
  && die "Local tag already exists: ${TAG}"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  die "GitHub release already exists: ${TAG}"
fi

download_plugin_assets "$PREV_TAG"

echo "Validated plugin assets:"
echo "  ${BACKEND_ZIP}"
echo "  ${FRONTEND_ZIP}"

echo "Running the non-GUI release test suite..."
npm run test:all
[ -z "$(git status --porcelain)" ] || die "Release checks modified the worktree."

if [ "${1:-}" = "--check" ]; then
  echo ""
  echo "✅ Release checks passed. The next release would be ${TAG}."
  exit 0
fi

echo "Bumping version: ${CURRENT_VERSION} → ${NEW_VERSION}"
npm version "$NEW_VERSION" --no-git-tag-version --quiet

git add package.json package-lock.json
git commit -m "Release ${TAG}"
git tag "$TAG"
git push origin main "$TAG"

RELEASE_NOTES="## IDE plugin downloads

This release contains only the two JetBrains IDE plugin ZIPs:

- **${BACKEND_ZIP}** — Host/backend plugin for file and symbol resolution
- **${FRONTEND_ZIP}** — Client/frontend plugin for editor scrolling, caret reporting, and the read-only editor guard

## Install in IntelliJ IDEA or PyCharm

In Remote Development (WSL) settings:

1. Select **Host** → **Settings → Plugins → ⚙ → Install Plugin from Disk**, then install **${BACKEND_ZIP}**.
2. Select **Client** → **Settings → Plugins → ⚙ → Install Plugin from Disk**, then install **${FRONTEND_ZIP}**.

For a local (non-remote) IDE, install both ZIPs into the same IDE.

## AgentTerm application

No AgentTerm application installer or package is published. Run AgentTerm directly from source by following the [development guide](https://github.com/${REPO}/blob/${TAG}/DEVELOPMENT.md)."

echo "Creating plugin-only release ${TAG}..."
gh release create "$TAG" \
  --repo "$REPO" \
  --verify-tag \
  --title "AgentTerm IDE Plugins ${TAG}" \
  --notes "$RELEASE_NOTES" \
  --latest \
  "$PLUGIN_TMP_DIR/$BACKEND_ZIP" \
  "$PLUGIN_TMP_DIR/$FRONTEND_ZIP"

echo ""
echo "✅ ${TAG}: https://github.com/${REPO}/releases/tag/${TAG}"
