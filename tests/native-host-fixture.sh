#!/bin/bash
set -uo pipefail

# Refuse to source the host unless every writable root is the test sandbox.
[[ -n ${TEST_ROOT:-} && $HOME == "$TEST_ROOT/home" &&
  $XDG_RUNTIME_DIR == "$TEST_ROOT/runtime" && $TMPDIR == "$TEST_ROOT/tmp" &&
  $OMARCHY_PATH == "$TEST_ROOT/omarchy" && -d $OMARCHY_PATH/themes ]] || exit 90

source "${BASH_SOURCE[0]%/*}/../bin/webtwist-host"

setsid() {
  [[ ! -e /proc/$BASHPID/fd/8 ]] || printf 'inherited install lock\n' >>"$TEST_ROOT/lock-leak"
  printf '%s\n' "$*" >>"$TEST_ROOT/setter-calls"
}
omarchy-theme-set() { return 99; }
date() { printf '%s\n' "$TEST_NOW"; }
omarchy-theme-list() {
  local entry
  for entry in "$USER_THEMES_DIR"/* "$OMARCHY_PATH/themes"/*; do
    [[ -d $entry || -L $entry ]] && printf '%s\n' "${entry##*/}"
  done
  return 0
}
mv() {
  if [[ ${TEST_TIMESTAMP_FAILURE:-} == 1 && ${@: -1} == "$INSTALL_STATE_DIR/last-install" ]]; then
    return 1
  fi
  if [[ ${1:-} == --no-copy && ${2:-} == -nT ]]; then
    local dest=${@: -1}
    case ${TEST_PUBLICATION:-} in
      fail) return 1 ;;
      skip) return 0 ;;
      interrupt) kill -TERM "$BASHPID" ;;
      directory)
        mkdir -- "$dest"
        printf 'competing creator\n' >"$dest/sentinel"
        ;;
      symlink) ln -s -- "$TEST_ROOT/victim" "$dest" ;;
      hold)
        printf 'ready\n' >"$TEST_ROOT/publishing"
        sleep 1
        ;;
    esac
  fi
  command mv "$@"
}
du() {
  [[ ${TEST_QUOTA_FAILURE:-} != 1 ]] || return 1
  command du "$@"
}

emit_palette
read_requests
