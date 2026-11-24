#!/usr/bin/env bash
# Check common onboarding, sync, and client wiring issues.

set -u

cd "$(dirname "$0")/.."

issues=0
warnings=0

ok() {
    printf 'OK   %s\n' "$1"
}

warn() {
    warnings=$((warnings + 1))
    printf 'WARN %s\n' "$1"
}

fail() {
    issues=$((issues + 1))
    printf 'FAIL %s\n' "$1"
}

expand_home() {
    local path="$1"
    printf '%s\n' "${path/#\~/$HOME}"
}

check_command() {
    local name="$1"
    if command -v "$name" >/dev/null 2>&1; then
        ok "$name is installed"
    else
        fail "$name is not installed"
    fi
}

resolve_dir() {
    local path="$1"
    if [[ -d "$path" ]]; then
        (cd "$path" && pwd -P)
    else
        printf '%s\n' "$path"
    fi
}

to_posix() {
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -u "$1"
    else
        printf '%s\n' "$1"
    fi
}

plugins_configured=false
if [[ -f local.yaml ]] && command -v yq >/dev/null 2>&1 \
    && [[ "$(yq e '.plugins // {} | length' local.yaml 2>/dev/null)" != "0" ]]; then
    plugins_configured=true
fi

# Clients that load plugins should read the *-without-plugins view; reading the
# full folder makes every plugin-delivered skill or agent load twice.
check_client_link() {
    local label="$1" path="$2" expected="$3" advice="$4"
    local expected_real full_real target_real target_text full="${3%-without-plugins}"

    expected_real=$(resolve_dir "$PWD/$expected")
    full_real=$(resolve_dir "$PWD/$full")
    if [[ -L "$path" ]]; then
        target_real=$(resolve_dir "$path")
        target_text=$(readlink "$path")
        if [[ "$target_real" == "$expected_real" ]]; then
            ok "$label points at $expected/"
        elif [[ "$target_real" == "$full_real" && "$expected" != "$full" ]]; then
            if $plugins_configured; then
                warn "$label points at $full/, so items from plugins load twice; point it at $expected/ (docs/plugins.md)"
            else
                ok "$label points at $full/ (no plugins configured, so $expected/ holds the same items)"
            fi
        else
            warn "$label symlink points elsewhere: $target_text"
        fi
    elif [[ -e "$path" ]]; then
        warn "$path exists but is not a symlink; $advice"
    else
        warn "$path is not linked to this repo"
    fi
}

# Fails when a client enables more than one copy of a plugin: same-named plugins
# shadow each other, so which one runs is not under your control.
check_plugin_copies() {
    local client="$1" name="$2" wanted="$3" enabled="${4:-}" count
    count=$(printf '%s' "$enabled" | grep -c . || true)
    if (( count > 1 )); then
        fail "$client enables more than one copy of '$name' ($(echo $enabled)); run ./scripts/plugins.sh"
    elif (( count == 0 )); then
        warn "$client has no enabled copy of '$name'; run ./scripts/plugins.sh"
    elif [[ "$enabled" != "$wanted" ]]; then
        warn "$client loads $enabled but local.yaml asks for $wanted; run ./scripts/plugins.sh"
    else
        ok "$client loads $enabled"
    fi
}

echo "AI repo doctor"
echo "=============="

check_command git
check_command yq

if command -v yq >/dev/null 2>&1; then
    yq_version=$(yq --version 2>/dev/null || true)
    if [[ "$yq_version" == *"mikefarah"* || "$yq_version" == *"version v4"* ]]; then
        ok "yq is Mike Farah v4-compatible"
    else
        fail "yq is not Mike Farah v4-compatible: ${yq_version:-unknown}"
    fi
fi

if [[ -f external-skills.yaml ]]; then
    ok "external-skills.yaml exists"
else
    fail "external-skills.yaml is missing"
fi

if [[ -f local.yaml ]]; then
    ok "local.yaml exists"
else
    warn "local.yaml is missing; copy local.yaml.example to enable local collections"
fi

hooks_path=$(git config --get core.hooksPath || true)
if [[ "$hooks_path" == ".githooks" ]]; then
    ok "git hooks point at .githooks"
else
    warn "git hooks are not enabled for this repo; run ./setup.sh"
fi

for dir in skills agents skills-without-plugins agents-without-plugins; do
    if [[ -d "$dir" ]]; then
        ok "$dir/ exists"
    else
        warn "$dir/ does not exist yet; run ./scripts/sync.sh"
    fi
done

if [[ -d skills ]]; then
    broken_skills=$(find skills -maxdepth 1 -type l ! -exec test -e {} \; -print)
    if [[ -z "$broken_skills" ]]; then
        ok "no broken skill symlinks"
    else
        fail "broken skill symlinks found:"
        printf '%s\n' "$broken_skills"
    fi
fi

if [[ -f local.yaml && -x "$(command -v yq 2>/dev/null)" ]]; then
    collection_names=$(yq e '.collections | keys | .[]' local.yaml 2>/dev/null || true)
    if [[ -z "$collection_names" ]]; then
        warn "local.yaml has no collections"
    else
        while IFS= read -r collection; do
            [[ -z "$collection" ]] && continue
            raw_path=$(yq e ".collections.$collection.path // \"\"" local.yaml)
            path=$(expand_home "$raw_path")
            if [[ -z "$raw_path" ]]; then
                fail "collection '$collection' has no path"
            elif [[ -d "$path" ]]; then
                ok "collection '$collection' path exists: $path"
            else
                warn "collection '$collection' path does not exist: $path"
            fi
        done <<< "$collection_names"
    fi
fi

check_client_link "Claude Code skills" "$HOME/.claude/skills" "skills-without-plugins" "back it up before replacing"
check_client_link "Claude Code agents" "$HOME/.claude/agents" "agents-without-plugins" "back it up before replacing"
check_client_link "Copilot skills" "$HOME/.copilot/skills" "skills-without-plugins" "use VS Code settings or back it up before replacing"
# OpenCode has no plugin support, so it needs the full folder. Without its own
# link it only sees ~/.claude/skills, which leaves out plugin-delivered skills.
if command -v opencode >/dev/null 2>&1; then
    check_client_link "OpenCode skills" "$HOME/.config/opencode/skills" "skills" "back it up before replacing"
fi

if $plugins_configured; then
    dev_root=$(yq e '.dev_marketplace.root // ""' local.yaml)
    [[ -n "$dev_root" ]] && dev_root=$(to_posix "$(expand_home "$dev_root")")
    dev_manifest="$dev_root/.claude-plugin/marketplace.json"
    claude_json=""
    if command -v claude >/dev/null 2>&1; then
        claude_json=$(claude plugin list --json 2>/dev/null || true)
    fi
    copilot_settings="$HOME/.copilot/settings.json"

    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        mode=$(P="$name" yq e '.plugins[strenv(P)].mode // "published"' local.yaml)
        path=$(P="$name" yq e '.plugins[strenv(P)].path // ""' local.yaml)
        if [[ "$mode" == "dev" ]]; then
            wanted="$name@$(yq e '.dev_marketplace.name // "local"' local.yaml)"
        else
            wanted="$name@$(P="$name" yq e '.plugins[strenv(P)].marketplace // ""' local.yaml)"
        fi
        if [[ "$mode" == "dev" ]]; then
            if [[ -z "$dev_root" || ! -f "$dev_root/$path/.claude-plugin/plugin.json" ]]; then
                fail "plugin '$name' is in dev mode but '$dev_root/$path' has no .claude-plugin/plugin.json"
            elif [[ ! -f "$dev_manifest" || -z "$(N="$name" yq -p=json -oy '.plugins[] | select(.name == strenv(N)) | .name' "$dev_manifest")" ]]; then
                warn "plugin '$name' is not in $dev_manifest yet; run ./scripts/plugins.sh"
            else
                ok "plugin '$name' dev copy: $dev_root/$path"
            fi
        fi
        if [[ -n "$claude_json" ]]; then
            check_plugin_copies "Claude Code" "$name" "$wanted" "$(N="$name" yq -p=json -oy '[.[]
                | select((.id | split("@") | .[0]) == strenv(N) and .enabled == true) | .id] | unique | .[]' <<< "$claude_json")"
        fi
        if command -v copilot >/dev/null 2>&1 && [[ -f "$copilot_settings" ]]; then
            check_plugin_copies "Copilot" "$name" "$wanted" "$(N="$name" yq -p=json -oy '.enabledPlugins // {} | to_entries | .[]
                | select((.key | split("@") | .[0]) == strenv(N) and .value == true) | .key' "$copilot_settings")"
        fi
    done <<< "$(yq e '.plugins | keys | .[]' local.yaml)"
fi

echo ""
if [[ "$issues" -gt 0 ]]; then
    echo "Doctor found $issues issue(s) and $warnings warning(s)."
    exit 1
fi

echo "Doctor found no blocking issues and $warnings warning(s)."
