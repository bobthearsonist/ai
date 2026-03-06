#!/bin/bash
# Setup script for AI repo
# Run this once after cloning to enable git hooks and sync external skills

set -e

echo "🔧 Setting up AI repo..."

# Configure git to use committed hooks
git config core.hooksPath .githooks
echo "✅ Git hooks enabled (.githooks/)"

# Sync external skills
if [ -f scripts/sync.sh ]; then
    echo "🔄 Syncing external skills..."
    ./scripts/sync.sh
    echo "✅ External skills synced"
else
    echo "⚠️  sync.sh not found, skipping"
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "External skills will now sync automatically on:"
echo "  - git checkout (branch switch)"
echo "  - git pull/merge"
echo ""
echo "To manually sync: ./scripts/sync.sh"
