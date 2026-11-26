import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseYaml } from 'yaml';
import { Agent, AgentFrontmatter, AgentRelation, WorkflowState } from '../types';

export class AgentService {
    private agentsPath: string;
    private agents: Agent[] = [];
    private onAgentsChangedEmitter = new vscode.EventEmitter<void>();
    public readonly onAgentsChanged = this.onAgentsChangedEmitter.event;

    constructor() {
        this.agentsPath = this.getAgentsPath();
    }

    private getAgentsPath(): string {
        const config = vscode.workspace.getConfiguration('claudeTaskVisualizer');
        const customPath = config.get<string>('agentsPath');

        if (customPath && fs.existsSync(customPath)) {
            return customPath;
        }

        // Default to ~/ai/agents/opencode
        return path.join(os.homedir(), 'ai', 'agents', 'opencode');
    }

    public async loadAgents(): Promise<void> {
        this.agents = [];

        if (!fs.existsSync(this.agentsPath)) {
            return;
        }

        try {
            const files = fs.readdirSync(this.agentsPath);

            for (const file of files) {
                if (!file.endsWith('.md')) {
                    continue;
                }

                const filePath = path.join(this.agentsPath, file);
                const agent = await this.parseAgentFile(filePath, file);

                if (agent) {
                    this.agents.push(agent);
                }
            }

            this.onAgentsChangedEmitter.fire();
        } catch (error) {
            console.error('Error loading agents:', error);
        }
    }

    private async parseAgentFile(filePath: string, filename: string): Promise<Agent | undefined> {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');

            // Parse YAML frontmatter; agent files checked out on Windows use CRLF.
            const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

            if (!frontmatterMatch) {
                return undefined;
            }

            const frontmatterYaml = frontmatterMatch[1];
            const bodyContent = frontmatterMatch[2];

            // Simple YAML parsing for the frontmatter
            const frontmatter = this.parseYamlFrontmatter(frontmatterYaml);

            if (!frontmatter) {
                return undefined;
            }

            return {
                name: filename.replace('.md', ''),
                filename,
                frontmatter,
                content: bodyContent,
                isActive: false
            };
        } catch (error) {
            console.error(`Error parsing agent file ${filename}:`, error);
            return undefined;
        }
    }

    private parseYamlFrontmatter(text: string): AgentFrontmatter | undefined {
        try {
            const result = (parseYaml(text) ?? {}) as Partial<AgentFrontmatter>;
            return {
                description: result.description || '',
                mode: result.mode || 'primary',
                model: result.model,
                temperature: result.temperature,
                permission: result.permission,
                tools: result.tools
            };
        } catch (error) {
            console.error('Error parsing YAML frontmatter:', error);
            return undefined;
        }
    }

    public getAgents(): Agent[] {
        return this.agents;
    }

    public getAgent(name: string): Agent | undefined {
        return this.agents.find(a => a.name === name);
    }

    public getAgentRelations(): AgentRelation[] {
        const relations: AgentRelation[] = [];
        const seen = new Set<string>();
        const add = (from: string, to: string) => {
            const key = `${from}->${to}`;
            if (from !== to && !seen.has(key)) {
                seen.add(key);
                relations.push({ from, to, type: 'delegates_to' });
            }
        };

        for (const agent of this.agents) {
            // permission.task is the declared delegation list: agent-name globs
            // mapped to allow / ask / deny. Anything not denied can be delegated to.
            for (const [pattern, decision] of Object.entries(agent.frontmatter.permission?.task ?? {})) {
                if (decision === 'deny') {
                    continue;
                }
                const glob = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
                for (const target of this.agents) {
                    if (glob.test(target.name)) {
                        add(agent.name, target.name);
                    }
                }
            }

            // Prose @mentions of other agents also count.
            const mentionPattern = /@([\w-]+)/g;
            let match;
            while ((match = mentionPattern.exec(agent.content)) !== null) {
                const target = this.agents.find(a => a.name.toLowerCase() === match![1].toLowerCase());
                if (target) {
                    add(agent.name, target.name);
                }
            }
        }

        return relations;
    }

    public getWorkflowState(): WorkflowState {
        // For now, return a default state
        // This could be enhanced to track actual workflow execution
        return {
            currentAgent: undefined,
            activeAgents: [],
            recentDelegations: []
        };
    }

    public setActiveAgent(agentName: string): void {
        for (const agent of this.agents) {
            agent.isActive = agent.name === agentName;
        }
        this.onAgentsChangedEmitter.fire();
    }

    public reloadConfiguration(): void {
        this.agentsPath = this.getAgentsPath();
        this.loadAgents();
    }

    public dispose(): void {
        this.onAgentsChangedEmitter.dispose();
    }
}
