import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionData } from '../types';
import { findProjectDir, loadCurrentSession } from './taskStore';

/** Coalesces bursts of file events; a task update writes several files. */
const CHANGE_DEBOUNCE_MS = 150;

export class ClaudeDataService {
    private claudeDataPath: string;
    private currentWorkspace: string | undefined;
    private watchers: fs.FSWatcher[] = [];
    private debounce: NodeJS.Timeout | undefined;
    private onDataChangedEmitter = new vscode.EventEmitter<void>();
    public readonly onDataChanged = this.onDataChangedEmitter.event;

    constructor() {
        this.claudeDataPath = this.getClaudeDataPath();
        this.currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private getClaudeDataPath(): string {
        const config = vscode.workspace.getConfiguration('claudeTaskVisualizer');
        const customPath = config.get<string>('claudeDataPath');
        if (customPath && fs.existsSync(customPath)) {
            return customPath;
        }
        return path.join(os.homedir(), '.claude');
    }

    public async getCurrentSession(): Promise<SessionData | undefined> {
        if (!this.currentWorkspace) {
            return undefined;
        }
        try {
            return loadCurrentSession(this.claudeDataPath, this.currentWorkspace);
        } catch (error) {
            console.error('Error loading current session:', error);
            return undefined;
        }
    }

    private fireChanged(): void {
        if (this.debounce) {
            clearTimeout(this.debounce);
        }
        this.debounce = setTimeout(() => this.onDataChangedEmitter.fire(), CHANGE_DEBOUNCE_MS);
    }

    private watch(dir: string, recursive: boolean, matches: (file: string) => boolean): void {
        if (!fs.existsSync(dir)) {
            return;
        }
        try {
            this.watchers.push(fs.watch(dir, { recursive }, (_event, filename) => {
                if (filename && matches(filename.toString())) {
                    this.fireChanged();
                }
            }));
        } catch (error) {
            console.error(`Error watching ${dir}:`, error);
        }
    }

    public startWatching(): void {
        if (!this.currentWorkspace) {
            return;
        }
        // Task edits land under tasks/; a new session shows up as a new transcript.
        this.watch(path.join(this.claudeDataPath, 'tasks'), true, file => file.endsWith('.json'));
        const projectDir = findProjectDir(this.claudeDataPath, this.currentWorkspace);
        if (projectDir) {
            this.watch(projectDir, false, file => file.endsWith('.jsonl'));
        }
    }

    public stopWatching(): void {
        for (const watcher of this.watchers) {
            watcher.close();
        }
        this.watchers = [];
        if (this.debounce) {
            clearTimeout(this.debounce);
            this.debounce = undefined;
        }
    }

    public reloadConfiguration(): void {
        this.stopWatching();
        this.claudeDataPath = this.getClaudeDataPath();
        this.startWatching();
    }

    public dispose(): void {
        this.stopWatching();
        this.onDataChangedEmitter.dispose();
    }
}
