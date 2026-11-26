// A task from Claude Code's task list (~/.claude/tasks/<list>/<id>.json).
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  id: string;
  content: string;
  description?: string;
  status: TodoStatus;
  activeForm?: string;
  blockedBy: string[];
}

export interface SessionData {
  sessionId: string;
  projectPath: string;
  summary?: string;
  taskCount: number;
  completedCount: number;
  /** When the session's task list last changed (ISO 8601). */
  modified: string;
  todos: Todo[];
}

// Agent types based on OpenCode agent format
export interface AgentFrontmatter {
  description: string;
  mode: 'primary' | 'subagent';
  model?: string;
  temperature?: number;
  permission?: {
    task?: Record<string, string>;
    edit?: string;
    bash?: string;
  };
  tools?: {
    write?: boolean;
    edit?: boolean;
    bash?: boolean;
    task?: boolean;
  };
}

export interface Agent {
  name: string;
  filename: string;
  frontmatter: AgentFrontmatter;
  content: string;
  isActive: boolean;
}

export interface AgentRelation {
  from: string;
  to: string;
  type: 'delegates_to' | 'uses' | 'reports_to';
}

// Workflow state
export interface WorkflowState {
  currentAgent?: string;
  activeAgents: string[];
  recentDelegations: AgentRelation[];
}

// Dashboard state
export interface DashboardState {
  todos: Todo[];
  agents: Agent[];
  workflowState: WorkflowState;
  currentSession?: SessionData;
  lastUpdated: number;
}

// Messages between extension and webview
export type WebviewMessage =
  | { type: 'refresh' }
  | { type: 'updateState'; state: DashboardState }
  | { type: 'selectAgent'; agentName: string }
  | { type: 'toggleTaskStatus'; index: number }
  | { type: 'error'; message: string };

export type ExtensionMessage =
  | { type: 'requestRefresh' }
  | { type: 'agentSelected'; agentName: string }
  | { type: 'openFile'; path: string };
