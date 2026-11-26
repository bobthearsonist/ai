import * as vscode from 'vscode';
import { ClaudeDataService } from '../services/ClaudeDataService';
import { AgentService } from '../services/AgentService';
import { DashboardState, WebviewMessage } from '../types';

export class DashboardViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'claudeTaskVisualizer.dashboard';

    private view?: vscode.WebviewView;
    private refreshTimeout?: NodeJS.Timeout;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly claudeDataService: ClaudeDataService,
        private readonly agentService: AgentService
    ) {
        // Listen for data changes
        this.claudeDataService.onDataChanged(() => {
            this.refresh();
        });

        this.agentService.onAgentsChanged(() => {
            this.refresh();
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
            switch (message.type) {
                case 'refresh':
                    this.refresh();
                    break;
                case 'selectAgent':
                    this.agentService.setActiveAgent(message.agentName);
                    break;
            }
        });

        // Initial data load
        this.refresh();

        // Set up periodic refresh
        const config = vscode.workspace.getConfiguration('claudeTaskVisualizer');
        const refreshInterval = config.get<number>('refreshInterval', 2000);

        this.startPeriodicRefresh(refreshInterval);
    }

    private startPeriodicRefresh(interval: number): void {
        if (this.refreshTimeout) {
            clearInterval(this.refreshTimeout);
        }

        this.refreshTimeout = setInterval(() => {
            this.refresh();
        }, interval);
    }

    public async refresh(): Promise<void> {
        if (!this.view) {
            return;
        }

        try {
            const session = await this.claudeDataService.getCurrentSession();
            const agents = this.agentService.getAgents();
            const workflowState = this.agentService.getWorkflowState();
            const showCompleted = vscode.workspace
                .getConfiguration('claudeTaskVisualizer')
                .get<boolean>('showCompletedTasks', true);

            const state: DashboardState = {
                todos: (session?.todos || []).filter(todo => showCompleted || todo.status !== 'completed'),
                agents,
                workflowState,
                currentSession: session,
                lastUpdated: Date.now()
            };

            this.view.webview.postMessage({
                type: 'updateState',
                state
            } as WebviewMessage);
        } catch (error) {
            console.error('Error refreshing dashboard:', error);
            this.view.webview.postMessage({
                type: 'error',
                message: 'Failed to refresh dashboard'
            } as WebviewMessage);
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Claude Task Dashboard</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --text-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --accent-color: var(--vscode-button-background);
            --success-color: var(--vscode-testing-iconPassed);
            --warning-color: var(--vscode-editorWarning-foreground);
            --pending-color: var(--vscode-textPreformat-foreground);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--text-color);
            background: var(--bg-color);
            padding: 12px;
            line-height: 1.5;
        }

        .dashboard {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .section {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            overflow: hidden;
        }

        .section-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            background: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--border-color);
            font-weight: 600;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .section-content {
            padding: 12px;
        }

        /* Todo List Styles */
        .todo-list {
            list-style: none;
        }

        .todo-item {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
        }

        .todo-item:last-child {
            border-bottom: none;
        }

        .todo-status {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            flex-shrink: 0;
        }

        .todo-status.pending {
            background: var(--vscode-input-background);
            border: 2px solid var(--pending-color);
            color: var(--pending-color);
        }

        .todo-status.in_progress {
            background: var(--warning-color);
            color: var(--bg-color);
            animation: pulse 2s infinite;
        }

        .todo-status.completed {
            background: var(--success-color);
            color: var(--bg-color);
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }

        .todo-content {
            flex: 1;
        }

        .todo-text {
            font-size: 13px;
        }

        .todo-active-form {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
            font-style: italic;
        }

        /* Agent Workflow Styles */
        .agent-graph {
            min-height: 200px;
            position: relative;
        }

        .agent-nodes {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            justify-content: center;
        }

        .agent-node {
            background: var(--vscode-button-secondaryBackground);
            border: 2px solid var(--border-color);
            border-radius: 8px;
            padding: 12px;
            min-width: 120px;
            text-align: center;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .agent-node:hover {
            border-color: var(--accent-color);
            transform: translateY(-2px);
        }

        .agent-node.primary {
            border-color: var(--accent-color);
        }

        .agent-node.subagent {
            border-color: var(--vscode-editorInfo-foreground);
        }

        .agent-node.active {
            background: var(--accent-color);
            color: var(--vscode-button-foreground);
        }

        .agent-name {
            font-weight: 600;
            font-size: 12px;
            margin-bottom: 4px;
        }

        .agent-mode {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
        }

        .agent-node.active .agent-mode {
            color: inherit;
            opacity: 0.8;
        }

        /* Agent relations SVG */
        .agent-relations {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 0;
        }

        .relation-line {
            stroke: var(--border-color);
            stroke-width: 1.5;
            fill: none;
            stroke-dasharray: 5;
            opacity: 0.5;
        }

        /* Session Info */
        .session-info {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .session-info span {
            margin-right: 12px;
        }

        /* Empty State */
        .empty-state {
            text-align: center;
            padding: 24px;
            color: var(--vscode-descriptionForeground);
        }

        .empty-state-icon {
            font-size: 32px;
            margin-bottom: 8px;
        }

        /* Refresh Button */
        .refresh-btn {
            background: none;
            border: none;
            color: var(--text-color);
            cursor: pointer;
            padding: 4px;
            opacity: 0.7;
            transition: opacity 0.2s;
        }

        .refresh-btn:hover {
            opacity: 1;
        }

        /* Legend */
        .legend {
            display: flex;
            gap: 16px;
            justify-content: center;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
        }

        .legend-item {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }

        .legend-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
        }

        .legend-dot.primary {
            background: var(--accent-color);
        }

        .legend-dot.subagent {
            background: var(--vscode-editorInfo-foreground);
        }
    </style>
</head>
<body>
    <div class="dashboard" id="dashboard">
        <div class="section">
            <div class="section-header">
                <span>📋 Task List</span>
                <button class="refresh-btn" id="refreshBtn" title="Refresh">↻</button>
            </div>
            <div class="section-content">
                <ul class="todo-list" id="todoList">
                    <div class="empty-state">
                        <div class="empty-state-icon">📝</div>
                        <div>No active tasks</div>
                    </div>
                </ul>
            </div>
        </div>

        <div class="section">
            <div class="section-header">
                <span>🤖 Agent Workflow</span>
            </div>
            <div class="section-content">
                <div class="agent-graph" id="agentGraph">
                    <div class="agent-nodes" id="agentNodes">
                        <div class="empty-state">
                            <div class="empty-state-icon">🔧</div>
                            <div>No agents loaded</div>
                        </div>
                    </div>
                </div>
                <div class="legend">
                    <div class="legend-item">
                        <div class="legend-dot primary"></div>
                        <span>Primary</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-dot subagent"></div>
                        <span>Subagent</span>
                    </div>
                </div>
            </div>
        </div>

        <div class="session-info" id="sessionInfo">
            Loading...
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        let currentState = null;

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.type) {
                case 'updateState':
                    currentState = message.state;
                    renderDashboard(message.state);
                    break;
                case 'error':
                    console.error(message.message);
                    break;
            }
        });

        // Refresh button
        document.getElementById('refreshBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        function renderDashboard(state) {
            renderTodoList(state.todos);
            renderAgentGraph(state.agents);
            renderSessionInfo(state.currentSession, state.lastUpdated);
        }

        function renderTodoList(todos) {
            const container = document.getElementById('todoList');

            if (!todos || todos.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">📝</div>
                        <div>No active tasks</div>
                    </div>
                \`;
                return;
            }

            container.innerHTML = todos.map((todo) => \`
                <li class="todo-item" title="\${escapeAttr(todo.description || '')}">
                    <div class="todo-status \${todo.status}">
                        \${getStatusIcon(todo.status)}
                    </div>
                    <div class="todo-content">
                        <div class="todo-text">#\${escapeHtml(todo.id)} \${escapeHtml(todo.content)}</div>
                        \${todo.status === 'in_progress' && todo.activeForm ? \`<div class="todo-active-form">\${escapeHtml(todo.activeForm)}</div>\` : ''}
                        \${todo.status !== 'completed' && todo.blockedBy && todo.blockedBy.length ? \`<div class="todo-active-form">Blocked by \${todo.blockedBy.map(id => '#' + escapeHtml(id)).join(', ')}</div>\` : ''}
                    </div>
                </li>
            \`).join('');
        }

        function getStatusIcon(status) {
            switch (status) {
                case 'completed': return '✓';
                case 'in_progress': return '▶';
                default: return '○';
            }
        }

        function renderAgentGraph(agents) {
            const container = document.getElementById('agentNodes');

            if (!agents || agents.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">🔧</div>
                        <div>No agents loaded</div>
                    </div>
                \`;
                return;
            }

            // Sort agents: primary first, then subagents
            const sortedAgents = [...agents].sort((a, b) => {
                if (a.frontmatter.mode === 'primary' && b.frontmatter.mode !== 'primary') return -1;
                if (a.frontmatter.mode !== 'primary' && b.frontmatter.mode === 'primary') return 1;
                return a.name.localeCompare(b.name);
            });

            container.innerHTML = sortedAgents.map(agent => \`
                <div class="agent-node \${agent.frontmatter.mode} \${agent.isActive ? 'active' : ''}"
                     data-agent="\${escapeHtml(agent.name)}"
                     title="\${escapeHtml(agent.frontmatter.description)}">
                    <div class="agent-name">\${formatAgentName(agent.name)}</div>
                    <div class="agent-mode">\${agent.frontmatter.mode}</div>
                </div>
            \`).join('');

            // Add click handlers
            container.querySelectorAll('.agent-node').forEach(node => {
                node.addEventListener('click', () => {
                    const agentName = node.dataset.agent;
                    vscode.postMessage({ type: 'selectAgent', agentName });
                });
            });
        }

        function formatAgentName(name) {
            return name
                .replace(/-/g, ' ')
                .replace(/\\b\\w/g, c => c.toUpperCase());
        }

        function renderSessionInfo(session, lastUpdated) {
            const container = document.getElementById('sessionInfo');

            if (!session) {
                container.innerHTML = '<span>No active session</span>';
                return;
            }

            const updated = new Date(lastUpdated).toLocaleTimeString();

            container.innerHTML = \`
                <span>📂 \${session.summary || 'Current session'}</span>
                <span>✅ \${session.completedCount}/\${session.taskCount} done</span>
                <span>🔄 Updated \${updated}</span>
            \`;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // textContent escaping leaves quotes alone, which breaks attribute values.
        function escapeAttr(text) {
            return escapeHtml(text).replace(/"/g, '&quot;');
        }
    </script>
</body>
</html>`;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    public dispose(): void {
        if (this.refreshTimeout) {
            clearInterval(this.refreshTimeout);
        }
    }
}
