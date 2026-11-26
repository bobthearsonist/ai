import * as vscode from 'vscode';
import { DashboardViewProvider } from './providers/DashboardViewProvider';
import { ClaudeDataService } from './services/ClaudeDataService';
import { AgentService } from './services/AgentService';

let dashboardProvider: DashboardViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('Claude Task Visualizer is now active');

  // Initialize services
  const claudeDataService = new ClaudeDataService();
  const agentService = new AgentService();

  // Create the dashboard provider
  dashboardProvider = new DashboardViewProvider(
    context.extensionUri,
    claudeDataService,
    agentService,
  );

  // Register the webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'claudeTaskVisualizer.dashboard',
      dashboardProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTaskVisualizer.refresh', () => {
      dashboardProvider?.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTaskVisualizer.openSettings', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'claudeTaskVisualizer',
      );
    }),
  );

  // Start watching for file changes
  claudeDataService.startWatching();
  agentService.loadAgents();

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeTaskVisualizer')) {
        claudeDataService.reloadConfiguration();
        agentService.reloadConfiguration();
        dashboardProvider?.refresh();
      }
    }),
  );
}

export function deactivate() {
  dashboardProvider = undefined;
}
