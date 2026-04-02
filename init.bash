#!/bin/bash
# ~/AI/init.bash — Developer shell integrations
# Sourced by ~/.bashrc
# NOTE: This is standalone tooling — not part of the AI skills/sync system.

###############################################################################
# OpenCode — local worktree build switcher
# Usage: opencode --use [list|<number>|<name>|reset]
###############################################################################

_opencode_use() {
    local OPENCODE_REPO="/c/Repositories/opencode"
    local CONFIG_FILE="$HOME/.opencode-local"
    
    # Get list of worktrees
    _get_worktrees() {
        git -C "$OPENCODE_REPO" worktree list 2>/dev/null | while IFS= read -r line; do
            # Extract path (first field)
            path=$(echo "$line" | awk '{print $1}')
            
            # Extract branch name from brackets
            if [[ "$line" =~ \[([^\]]+)\] ]]; then
                branch="${BASH_REMATCH[1]}"
                echo "$path|$branch"
            elif [[ "$line" =~ \(bare\) ]]; then
                # Skip bare repos
                continue
            elif [[ "$line" =~ \(detached\ HEAD\) ]]; then
                # Handle detached HEAD gracefully
                echo "$path|detached HEAD"
            fi
        done
    }
    
    # Get current selection
    _get_current() {
        if [[ -f "$CONFIG_FILE" ]]; then
            cat "$CONFIG_FILE"
        else
            echo ""
        fi
    }
    
    # Get npm version
    _get_npm_version() {
        local npm_bin="/c/nvm4w/nodejs/node_modules/opencode-ai/bin/opencode"
        if [[ -f "$npm_bin" ]]; then
            # Try to extract version from package.json
            local pkg_dir=$(dirname "$npm_bin")/../
            if [[ -f "$pkg_dir/package.json" ]]; then
                grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$pkg_dir/package.json" | cut -d'"' -f4 | head -1
            fi
        fi
    }
    
    # List worktrees
    _list_worktrees() {
        local current
        current=$(_get_current)
        
        echo "OpenCode local build selection:"
        
        if [[ -z "$current" ]]; then
            local npm_ver
            npm_ver=$(_get_npm_version)
            if [[ -n "$npm_ver" ]]; then
                echo "  Current: npm release (v$npm_ver)"
            else
                echo "  Current: npm release"
            fi
        else
            echo "  Current: $current"
        fi
        
        echo ""
        echo "Available worktrees:"
        
        local idx=1
        while IFS='|' read -r path branch; do
            local marker=""
            if [[ "$path" == "$current" ]]; then
                marker="*"
            fi
            printf "  %s%d) %-40s %s\n" "$marker" "$idx" "$branch" "$path"
            ((idx++))
        done < <(_get_worktrees)
        
        echo ""
        echo "Usage: opencode --use <number|name> | opencode --use reset"
    }
    
    # Select worktree by number
    _select_by_number() {
        local target_num=$1
        local idx=1
        
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
    
    # Select worktree by name (partial match)
    _select_by_name() {
        local target_name=$1
        local matches=()
        local paths=()
        
        while IFS='|' read -r path branch; do
            local path_basename=$(basename "$path")
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
            for match in "${matches[@]}"; do
                echo "  - $match" >&2
            done
            return 1
        else
            echo "${paths[0]}" > "$CONFIG_FILE"
            echo "✓ Selected: ${matches[0]} (${paths[0]})"
            return 0
        fi
    }
    
    # Reset to npm release
    _reset_selection() {
        if [[ -f "$CONFIG_FILE" ]]; then
            rm -f "$CONFIG_FILE"
            echo "✓ Reset to npm release"
        else
            echo "Already using npm release"
        fi
    }
    
    # Main logic
    local cmd="${1:-list}"
    
    case "$cmd" in
        list)
            _list_worktrees
            ;;
        reset)
            _reset_selection
            ;;
        [0-9]*)
            _select_by_number "$cmd"
            ;;
        *)
            _select_by_name "$cmd"
            ;;
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
    # Convert to Windows path if in MSYS2/Git Bash (Node.js can't read /c/... paths)
    command -v cygpath &>/dev/null && mitm_cert="$(cygpath -w "$mitm_cert")"

    # Determine which opencode binary/command to run
    local -a run_cmd
    local is_bun=false
    if [[ -f "$config" ]]; then
        local worktree_path
        worktree_path=$(cat "$config")
        if [[ -d "$worktree_path/packages/opencode/src" ]]; then
            echo "[opencode] Using local: $worktree_path" >&2
            run_cmd=("$HOME/.bun/bin/bun.exe" run --cwd "$worktree_path/packages/opencode" --conditions=browser src/index.ts)
            is_bun=true
        else
            echo "[opencode] Warning: Worktree not found at $worktree_path, falling back to npm release" >&2
            rm -f "$config"
            run_cmd=(node /c/nvm4w/nodejs/node_modules/opencode-ai/bin/opencode)
        fi
    else
        run_cmd=(node /c/nvm4w/nodejs/node_modules/opencode-ai/bin/opencode)
    fi

    # Share one session DB across all channels (release, dev, local, etc.)
    export OPENCODE_DISABLE_CHANNEL_DB=true

    # When using a local bun build, pass original PWD as project dir
    # (--cwd changes bun'''s working dir for module resolution, so opencode
    # would otherwise resolve the wrong project)
    local -a project_arg=()
    if [[ "$is_bun" == true ]]; then
        project_arg=("$PWD")
    fi

    # Check if dev container mitmproxy is running on port 8080
    if (echo >/dev/tcp/127.0.0.1/8080) 2>/dev/null; then
        echo "[opencode] Routing through context-lens mitmproxy" >&2

        # Bun 1.3.x on Windows ignores NODE_EXTRA_CA_CERTS and --use-system-ca
        # (oven-sh/bun#23735). Disable TLS verification for local mitmproxy
        # for both Node and Bun — NODE_EXTRA_CA_CERTS is unreliable across
        # runtimes. This is safe — it's our own local proxy.
        local -a env_vars=(
            https_proxy=http://127.0.0.1:8080
            NODE_EXTRA_CA_CERTS="$mitm_cert"
            NODE_TLS_REJECT_UNAUTHORIZED=0
        )

        env "${env_vars[@]}" "${run_cmd[@]}" "${project_arg[@]}" "$@"
    else
        # Fall back to context-lens CLI (starts its own servers + mitmproxy)
        context-lens --no-open opencode "${project_arg[@]}" "$@"
    fi
}
