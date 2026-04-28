#!/usr/bin/env zsh
# ~/AI/init.zsh — Developer shell integrations (macOS companion to init.bash)
# Sourced by ~/.zshrc
# NOTE: Standalone tooling — not part of the AI skills/sync system.

###############################################################################
# OpenCode — local worktree build switcher
# Usage: opencode --use [list|<number>|<name>|reset]
###############################################################################

_opencode_use() {
    local OPENCODE_REPO="$HOME/Repositories/opencode"
    local CONFIG_FILE="$HOME/.opencode-local"

    _get_worktrees() {
        git -C "$OPENCODE_REPO" worktree list 2>/dev/null | while IFS= read -r line; do
            local path branch
            path=$(echo "$line" | awk '{print $1}')
            if [[ "$line" =~ \[([^\]]+)\] ]]; then
                branch="${match[1]}"
                echo "$path|$branch"
            elif [[ "$line" =~ \(detached\ HEAD\) ]]; then
                echo "$path|detached HEAD"
            fi
        done
    }

    _get_current() {
        [[ -f "$CONFIG_FILE" ]] && cat "$CONFIG_FILE" || echo ""
    }

    _list_worktrees() {
        local current
        current=$(_get_current)
        echo "OpenCode local build selection:"
        if [[ -z "$current" ]]; then
            echo "  Current: homebrew release"
        else
            echo "  Current: $current"
        fi
        echo ""
        echo "Available worktrees:"
        local idx=1
        while IFS='|' read -r path branch; do
            local marker=""
            [[ "$path" == "$current" ]] && marker="*"
            printf "  %s%d) %-40s %s\n" "$marker" "$idx" "$branch" "$path"
            ((idx++))
        done < <(_get_worktrees)
        echo ""
        echo "Usage: opencode --use <number|name> | opencode --use reset"
    }

    _select_by_number() {
        local target_num=$1 idx=1
        while IFS='|' read -r path branch; do
            if [[ $idx -eq $target_num ]]; then
                echo "$path" > "$CONFIG_FILE"
                echo "✓ Selected: $branch ($path)"
                return 0
            fi
            ((idx++))
        done < <(_get_worktrees)
        echo "Error: Invalid number $target_num" >&2
        return 1
    }

    _select_by_name() {
        local target_name=$1
        local -a matches paths
        while IFS='|' read -r path branch; do
            local path_basename
            path_basename=$(basename "$path")
            if [[ "$branch" == *"$target_name"* ]] || [[ "$path_basename" == *"$target_name"* ]]; then
                matches+=("$branch")
                paths+=("$path")
            fi
        done < <(_get_worktrees)
        if [[ ${#matches[@]} -eq 0 ]]; then
            echo "Error: No worktree found matching '$target_name'" >&2
            return 1
        elif [[ ${#matches[@]} -gt 1 ]]; then
            echo "Error: Multiple worktrees match '$target_name':" >&2
            printf '  - %s\n' "${matches[@]}" >&2
            return 1
        fi
        echo "${paths[1]}" > "$CONFIG_FILE"
        echo "✓ Selected: ${matches[1]} (${paths[1]})"
    }

    _reset_selection() {
        if [[ -f "$CONFIG_FILE" ]]; then
            rm -f "$CONFIG_FILE"
            echo "✓ Reset to homebrew release"
        else
            echo "Already using homebrew release"
        fi
    }

    local cmd="${1:-list}"
    case "$cmd" in
        list)     _list_worktrees ;;
        reset)    _reset_selection ;;
        [0-9]*)   _select_by_number "$cmd" ;;
        *)        _select_by_name "$cmd" ;;
    esac
}

opencode() {
    if [[ "$1" == "--use" ]]; then
        shift
        _opencode_use "$@"
        return
    fi

    local config="$HOME/.opencode-local"
    local mitm_cert="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"

    # Determine which opencode binary/command to run
    local -a run_cmd
    local is_bun=false
    if [[ -f "$config" ]]; then
        local worktree_path
        worktree_path=$(cat "$config")
        if [[ -d "$worktree_path/packages/opencode/src" ]]; then
            echo "[opencode] Using local: $worktree_path" >&2
            run_cmd=(bun run --cwd "$worktree_path/packages/opencode" --conditions=browser src/index.ts)
            is_bun=true
        else
            echo "[opencode] Worktree not found at $worktree_path, falling back to homebrew release" >&2
            rm -f "$config"
            run_cmd=(/opt/homebrew/bin/opencode)
        fi
    else
        run_cmd=(/opt/homebrew/bin/opencode)
    fi

    # Share one session DB across all channels (release, dev, local, etc.)
    export OPENCODE_DISABLE_CHANNEL_DB=true

    # When using a local bun build, pass original PWD as project dir
    local -a project_arg=()
    [[ "$is_bun" == true ]] && project_arg=("$PWD")

    # Check if mitmproxy is running on port 8080
    if nc -z 127.0.0.1 8080 2>/dev/null; then
        echo "[opencode] Routing through context-lens mitmproxy" >&2

        # Bun 1.3.x ignores NODE_EXTRA_CA_CERTS / NODE_USE_SYSTEM_CA in its
        # native fetch path (undici dispatcher bypass — see oven-sh/bun#23735,
        # #24581). Opencode is a Bun binary that uses bun fetch, so neither
        # env var helps. Disable TLS verification for child processes routing
        # through our LOCAL mitmproxy. This is safe — the proxy is on
        # 127.0.0.1, the cert is ours, and traffic stays on this machine
        # before being forwarded upstream over a clean TLS connection.
        env \
            https_proxy=http://127.0.0.1:8080 \
            NODE_EXTRA_CA_CERTS="$mitm_cert" \
            NODE_TLS_REJECT_UNAUTHORIZED=0 \
            "${run_cmd[@]}" "${project_arg[@]}" "$@"
    else
        "${run_cmd[@]}" "${project_arg[@]}" "$@"
    fi
}
