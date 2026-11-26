# Claude Task Visualizer

A VS Code extension that provides a visual dashboard for Claude Code's todo/task lists and AI agent workflows.

## Features

- **Real-time Task Visualization**: See your Claude Code todo list at all times in a dedicated sidebar panel
- **Agent Workflow Graph**: Visualize available AI agents and their relationships
- **Live Updates**: Automatically refreshes as tasks change
- **Interactive**: Click agents to view details and track active workflows

## Screenshots

![Dashboard Screenshot](media/screenshot.png)

## Installation

### From Source

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Press F5 to launch the extension in a new VS Code window

### From VSIX Package

1. Run `npm run package` to create a `.vsix` file
2. Install the VSIX file in VS Code: Extensions → ... → Install from VSIX

## Configuration

The extension can be configured through VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeTaskVisualizer.claudeDataPath` | `~/.claude` | Path to Claude Code data directory |
| `claudeTaskVisualizer.agentsPath` | `~/ai/agents/opencode` | Path to OpenCode agents directory |
| `claudeTaskVisualizer.refreshInterval` | `2000` | Refresh interval in milliseconds |
| `claudeTaskVisualizer.showCompletedTasks` | `true` | Show completed tasks in the dashboard |

## Data Sources

### Claude Code tasks

The extension shows the task list of one Claude Code session for the open workspace:

- It finds the workspace's sessions in `~/.claude/projects/<workspace path with every non-alphanumeric character replaced by ->/`, one `<session id>.jsonl` transcript each.
- Each session's tasks are files in `~/.claude/tasks/session-<first 8 characters of the session id>/` (older Claude Code versions used `~/.claude/tasks/<session id>/`).
- When several sessions run in the workspace, it shows the one whose task list changed most recently. The header shows that session's title.

It watches both folders and refreshes when a task or transcript changes.

### AI Agents

Agents are loaded from markdown files with YAML frontmatter in the configured agents directory. The extension supports:
- OpenCode agent format (`.md` files with YAML frontmatter)
- Delegation edges from each agent's `permission.task` patterns (anything not `deny`) and from `@mentions` in agent content

## Task Status Icons

- ○ **Pending**: Task not yet started
- ▶ **In Progress**: Task currently being worked on (animated)
- ✓ **Completed**: Task finished

## Agent Types

- **Primary**: Main agents that can be directly invoked (blue border)
- **Subagent**: Specialized agents that are delegated to (cyan border)

## Commands

- `Claude: Refresh Dashboard` - Manually refresh the dashboard
- `Claude: Open Settings` - Open extension settings

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch

# Run linter
npm run lint

# Package extension
npm run package
```

## Requirements

- VS Code 1.85.0 or higher
- Claude Code installed with active sessions
- (Optional) OpenCode agents configured

## Known Issues

- First load may take a moment to detect the current workspace
- Large session files may cause slight delays in todo extraction

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

MIT
