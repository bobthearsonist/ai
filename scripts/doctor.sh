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

check_client_skills_link() {
    local label="$1" path="$2" advice="$3"
    local repo_skills target_real target_text

    repo_skills=$(resolve_dir "$PWD/skills")
    if [[ -L "$path" ]]; then
        target_real=$(resolve_dir "$path")
        target_text=$(readlink "$path")
        if [[ "$target_real" == "$repo_skills" ]]; then
            ok "$label skills symlink points at AI skills"
        else
            warn "$label skills symlink points elsewhere: $target_text"
        fi
    elif [[ -e "$path" ]]; then
        warn "$path exists but is not a symlink; $advice"
    else
        warn "$path is not linked to this repo"
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

for dir in skills agents; do
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

check_client_skills_link "Claude Code" "$HOME/.claude/skills" "back it up before replacing"
check_client_skills_link "Copilot" "$HOME/.copilot/skills" "use VS Code settings or back it up before replacing"

echo ""
if [[ "$issues" -gt 0 ]]; then
    echo "Doctor found $issues issue(s) and $warnings warning(s)."
    exit 1
fi

echo "Doctor found no blocking issues and $warnings warning(s)."
