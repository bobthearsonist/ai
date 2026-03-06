#!/usr/bin/env bash
# Sync external skills and agents from manifest and local collections
set -e

# Enable native symlinks on Windows (Git Bash/MSYS2). Ignored on macOS/Linux.
export MSYS=winsymlinks:nativestrict

cd "$(dirname "$0")/.."
CACHE=".external-cache"
MANIFEST="external-skills.yaml"
LOCAL_CONFIG="local.yaml"
mkdir -p "$CACHE"

sync_git() {
    local source="$1" branch="$2" path="$3" target="$4"

    local key
    if command -v md5 &>/dev/null; then
        key=$(echo "$source" | md5 -q)
    else
        key=$(echo "$source" | md5sum | cut -d' ' -f1)
    fi

    if [ -d "$CACHE/$key" ]; then
        git -C "$CACHE/$key" fetch --depth=1
    else
        git clone --depth=1 --sparse "$source" "$CACHE/$key"
    fi

    git -C "$CACHE/$key" sparse-checkout set "$path"
    git -C "$CACHE/$key" checkout

    rm -rf "$target"
    mkdir -p "$(dirname "$target")"
    cp -r "$CACHE/$key/$path" "$target"

    echo "  → $target (copied)"
}

sync_symlink() {
    local source="$1" target="$2"

    rm -rf "$target"
    mkdir -p "$(dirname "$target")"
    ln -s "$source" "$target"

    echo "  → $target (symlink)"
}

# === Sync external-skills.yaml (git-based skills) ===
echo "=== External skills ==="
count=$(yq e '.skills | length' "$MANIFEST")

for ((i=0; i<count; i++)); do
    type=$(yq e ".skills[$i].type // \"git\"" "$MANIFEST")
    [[ "$type" == "internal" ]] && continue

    name=$(yq e ".skills[$i].name" "$MANIFEST")
    echo "Syncing: $name ($type)"

    case "$type" in
        git)
            source=$(yq e ".skills[$i].source" "$MANIFEST")
            branch=$(yq e ".skills[$i].branch // \"main\"" "$MANIFEST")
            path=$(yq e ".skills[$i].path // \"\"" "$MANIFEST")
            target=$(yq e ".skills[$i].target" "$MANIFEST")
            sync_git "$source" "$branch" "$path" "$target"
            ;;
    esac
done

# === Sync collections from local.yaml ===
if [ ! -f "$LOCAL_CONFIG" ]; then
    echo "No local.yaml found, skipping collections."
    echo "Done!"
    exit 0
fi

sync_collection_items() {
    local collection="$1" key="$2" subdir="$3" target_dir="$4"
    local path count entry kind source_dir link_name source_path

    path=$(yq e ".collections.$collection.path" "$LOCAL_CONFIG")
    count=$(yq e ".collections.$collection.$key | length" "$LOCAL_CONFIG")
    [[ "$count" == "0" || "$count" == "null" ]] && return

    for ((i=0; i<count; i++)); do
        entry=$(yq e ".collections.$collection.${key}[$i]" "$LOCAL_CONFIG")
        kind=$(yq e ".collections.$collection.${key}[$i] | type" "$LOCAL_CONFIG")

        if [[ "$kind" == "!!str" ]]; then
            source_dir="$entry"
            link_name="$entry"
        else
            source_dir=$(yq e ".collections.$collection.${key}[$i].source" "$LOCAL_CONFIG")
            link_name=$(yq e ".collections.$collection.${key}[$i].name" "$LOCAL_CONFIG")
        fi

        if [[ -n "$subdir" ]]; then
            source_path="$path/$subdir/$source_dir"
        else
            source_path="$path/$source_dir"
        fi

        echo "Syncing: $link_name ($key symlink)"
        sync_symlink "$source_path" "$target_dir/$link_name"
    done
}

collection_names=$(yq e '.collections | keys | .[]' "$LOCAL_CONFIG" 2>/dev/null)

for collection in $collection_names; do
    path=$(yq e ".collections.$collection.path" "$LOCAL_CONFIG")

    if [ ! -d "$path" ]; then
        echo "=== Collection: $collection (SKIPPED — $path not found) ==="
        continue
    fi

    echo "=== Collection: $collection ==="

    skills_dir=$(yq e ".collections.$collection.skills_dir // \"skills\"" "$LOCAL_CONFIG")
    agents_dir=$(yq e ".collections.$collection.agents_dir // \"agents\"" "$LOCAL_CONFIG")

    sync_collection_items "$collection" "skills" "$skills_dir" "skills"
    sync_collection_items "$collection" "agents" "$agents_dir" "agents"
    # Root-level directory/file symlinks (no subdir prefix)
    sync_collection_items "$collection" "links" "" "."
done

echo "Done!"
