#!/bin/bash

# Register the Webtwist native messaging host for Firefox.
#
# Everything here is per-user and needs no root. Firefox reads a per-user native
# manifest from a fixed ~/.mozilla path even when the profile itself lives under
# XDG, and a build that honours XDG looks under the config dir instead, so both
# are written and neither has to guess.

set -euo pipefail

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
EXTENSION_DIR="${WEBTWIST_EXTENSION_DIR:-$REPO_DIR/extension}"
HOST_BIN="${WEBTWIST_HOST_BIN:-$REPO_DIR/bin/webtwist-host}"
HOST_NAME="com.webtwist.host"

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

# The add-on id is what the native manifest lists under allowed_extensions, so it
# has to match browser_specific_settings.gecko.id in extension/manifest.json
# exactly. Keep the two in sync if the id ever changes.
ADDON_ID="webtwist@signaldirective.github.io"

MOZ_HOST_DIR="$HOME/.mozilla/native-messaging-hosts"
MOZ_XDG_HOST_DIR="$CONFIG_HOME/mozilla/native-messaging-hosts"

uninstall=0
for arg in "$@"; do
  case $arg in
    --uninstall) uninstall=1 ;;
    *) echo "install.sh: unknown option: $arg" >&2; exit 2 ;;
  esac
done

[[ -x $HOST_BIN ]] || { echo "install.sh: host script not executable: $HOST_BIN" >&2; exit 1; }

if ! (( uninstall )); then
  [[ -f $EXTENSION_DIR/manifest.json ]] || { echo "install.sh: no manifest at $EXTENSION_DIR" >&2; exit 1; }
fi

for dir in "$MOZ_HOST_DIR" "$MOZ_XDG_HOST_DIR"; do
  manifest="$dir/$HOST_NAME.json"

  if (( uninstall )); then
    rm -f -- "$manifest"
    # Drop the directory only if this manifest was its last occupant, so an
    # unrelated native host is never disturbed.
    rmdir --ignore-fail-on-non-empty -- "$dir" 2>/dev/null || true
    continue
  fi

  mkdir -p -- "$dir"
  jq -n \
    --arg name "$HOST_NAME" \
    --arg path "$HOST_BIN" \
    --arg id "$ADDON_ID" \
    '{name: $name,
      description: "Webtwist native host",
      path: $path,
      type: "stdio",
      allowed_extensions: [$id]}' >"$manifest"
done

echo
if (( uninstall )); then
  echo "Removed the $HOST_NAME host manifest. Restart Firefox."
else
  echo "Registered $HOST_NAME for Firefox."
  echo
  echo "Load the add-on: in about:debugging -> This Firefox -> Load Temporary Add-on,"
  echo "pick $EXTENSION_DIR/manifest.json"
  echo
  echo "Release Firefox keeps an add-on only for the session. See the README for a"
  echo "permanent install."
fi
