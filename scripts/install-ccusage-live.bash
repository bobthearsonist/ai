#!/usr/bin/env bash
set -euo pipefail

profile_path="${PROFILE_PATH:-$HOME/.bashrc}"
install_ccusage=0

for arg in "$@"; do
  case "$arg" in
    --install-ccusage) install_ccusage=1 ;;
    --profile=*) profile_path="${arg#--profile=}" ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: install-ccusage-live.bash [--install-ccusage] [--profile=/path/to/profile]" >&2
      exit 2
      ;;
  esac
done

if (( install_ccusage )) && ! type -P ccusage.cmd >/dev/null 2>&1 && ! type -P ccusage >/dev/null 2>&1; then
  if ! type -P npm >/dev/null 2>&1; then
    echo "npm is required to install ccusage. Install Node.js/npm, then rerun this script." >&2
    exit 1
  fi

  npm install -g ccusage
fi

mkdir -p "$(dirname "$profile_path")"

start="# >>> ccusage-live-wrapper >>>"
end="# <<< ccusage-live-wrapper <<<"

block="$(cat <<'CCUSAGE_LIVE_BLOCK'
# >>> ccusage-live-wrapper >>>
ccusage() {
  local ccusage_bin
  if ccusage_bin="$(type -P ccusage.cmd)" && [[ -n "$ccusage_bin" ]]; then
    :
  elif ccusage_bin="$(type -P ccusage)" && [[ -n "$ccusage_bin" ]]; then
    :
  else
    echo "ccusage was not found. Install it with: npm install -g ccusage" >&2
    return 127
  fi

  if [[ "${1:-}" == "live" ]]; then
    shift
    local date="${1:-$(date +%Y%m%d)}"
    local token_limit=80000000
    local compact_width=200
    local original_columns="${COLUMNS-}"
    local had_columns=0
    [[ -v COLUMNS ]] && had_columns=1

    __ccusage_live_cleanup() {
      trap - RETURN INT TERM
      if [[ "$had_columns" == 1 ]]; then
        export COLUMNS="$original_columns"
      else
        unset COLUMNS
      fi
      printf '\e[?25h\e[?1049l'
      unset -f __ccusage_live_cleanup
    }

    printf '\e[?1049h\e[?25l'
    trap '__ccusage_live_cleanup' RETURN
    trap '__ccusage_live_cleanup; return 130' INT TERM

    local time
    time="$(date +%H:%M:%S)"
    printf '\e[H\e[2J'
    printf -- '--- ccusage LIVE for %s (%s) ---\nLoading first refresh...\n' "$date" "$time"

    while true; do
      time="$(date +%H:%M:%S)"

      local terminal_width
      terminal_width="$(tput cols 2>/dev/null || printf '%s' "${COLUMNS:-120}")"
      [[ "$terminal_width" =~ ^[0-9]+$ ]] || terminal_width=120
      (( terminal_width > 0 )) || terminal_width=120
      export COLUMNS="$terminal_width"

      local session blocks
      if (( terminal_width < compact_width )); then
        session="$("$ccusage_bin" session --since "$date" --compact --color 2>/dev/null || true)"
        blocks="$("$ccusage_bin" blocks --recent --token-limit "$token_limit" --compact --color 2>/dev/null || true)"
      else
        session="$("$ccusage_bin" session --since "$date" --color 2>/dev/null || true)"
        blocks="$("$ccusage_bin" blocks --recent --token-limit "$token_limit" --color 2>/dev/null || true)"
      fi

      if [[ "$session" != *"Claude Code Token Usage Report"* ]]; then
        session="No session usage found since $date."
      fi

      printf '\e[H\e[2J'
      printf -- '--- ccusage LIVE for %s (%s) ---\n%s\n\n--- Blocks ---\n%s' "$date" "$time" "$session" "$blocks"
      sleep 1
    done
  else
    "$ccusage_bin" "$@" 2>/dev/null
  fi
}
# <<< ccusage-live-wrapper <<<
CCUSAGE_LIVE_BLOCK
)"

if [[ -f "$profile_path" ]]; then
  tmp_file="$(mktemp)"
  inserted=0
  skipping=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$start" ]]; then
      if (( ! inserted )); then
        printf '%s\n' "$block" >> "$tmp_file"
        inserted=1
      fi
      skipping=1
      continue
    fi

    if (( skipping )); then
      [[ "$line" == "$end" ]] && skipping=0
      continue
    fi

    printf '%s\n' "$line" >> "$tmp_file"
  done < "$profile_path"

  if (( ! inserted )); then
    {
      printf '\n'
      printf '%s\n' "$block"
    } >> "$tmp_file"
  fi

  mv "$tmp_file" "$profile_path"
else
  printf '%s\n' "$block" > "$profile_path"
fi

bash_profile="$HOME/.bash_profile"
if [[ "$(basename "$profile_path")" == ".bashrc" && ! -f "$bash_profile" ]]; then
  printf '[[ -f ~/.bashrc ]] && source ~/.bashrc\n' > "$bash_profile"
fi

echo "Installed ccusage live wrapper to $profile_path"
if ! type -P ccusage.cmd >/dev/null 2>&1 && ! type -P ccusage >/dev/null 2>&1; then
  echo "Warning: ccusage was not found. Install it with: npm install -g ccusage" >&2
fi
echo "Reload your profile with: source '$profile_path'"
echo "Then run: ccusage live"
