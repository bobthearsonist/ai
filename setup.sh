#!/usr/bin/env bash
# Setup script for AI repo.

set -euo pipefail

cd "$(dirname "$0")"

skip_sync=false

usage() {
    cat <<'EOF'
Usage: ./setup.sh [--skip-sync]

Options:
  --skip-sync   Enable hooks and prepare local config without fetching/linking skills.
  -h, --help    Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-sync)
            skip_sync=true
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

require_command() {
    local name="$1" install_hint="$2"
    if ! command -v "$name" >/dev/null 2>&1; then
        echo "Missing required command: $name" >&2
        echo "Install hint: $install_hint" >&2
        exit 1
    fi
}

check_yq() {
    local version
    version=$(yq --version 2>/dev/null || true)
    if [[ "$version" != *"mikefarah"* && "$version" != *"version v4"* ]]; then
        echo "Unsupported yq detected: ${version:-unknown}" >&2
        echo "Install Mike Farah yq v4, for example: brew install yq" >&2
        exit 1
    fi
}

echo "Setting up AI repo..."

require_command git "Install Git from your OS package manager."
require_command yq "Install Mike Farah yq v4, for example: brew install yq"
check_yq

git config core.hooksPath .githooks
echo "Git hooks enabled (.githooks/)"

if [[ ! -f local.yaml && -f local.yaml.example ]]; then
    cp local.yaml.example local.yaml
    echo "Created local.yaml from local.yaml.example"
    echo "Edit local.yaml to point at your personal/work skills repos."
fi

if [[ "$skip_sync" == true ]]; then
    echo "Skipped initial sync."
else
    if [[ -f scripts/sync.sh ]]; then
        echo "Syncing skills and collections..."
        ./scripts/sync.sh
        echo "Sync complete."
    else
        echo "scripts/sync.sh not found, skipping sync."
    fi
fi

echo ""
echo "Setup complete."
echo ""
echo "Automatic sync is enabled for git checkout and git pull/merge."
echo "Next steps:"
echo "  1. Edit local.yaml for your machine."
echo "  2. Run ./scripts/sync.sh after local.yaml changes."
echo "  3. Run ./scripts/doctor.sh to verify setup."
