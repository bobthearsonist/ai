// Reads Claude Code's on-disk session and task data. Deliberately free of any
// `vscode` import so it can be exercised from plain Node against a real
// ~/.claude directory.
import * as fs from 'fs';
import * as path from 'path';
import { SessionData, Todo, TodoStatus } from '../types';

/** How many of the workspace's most recent transcripts to consider. */
const RECENT_SESSIONS = 30;
/** Bytes read from the end of a transcript when looking for its title. */
const TITLE_TAIL_BYTES = 256 * 1024;

/**
 * Claude Code names a project folder after its working directory, with every
 * character outside [A-Za-z0-9] replaced by '-':
 * C:\Users\me\Repos\app -> C--Users-me-Repos-app
 */
export function projectFolderName(workspacePath: string): string {
    return workspacePath.replace(/[^A-Za-z0-9]/g, '-');
}

/** Case-insensitive, because VS Code reports Windows drive letters in lower case. */
export function findProjectDir(claudeDir: string, workspacePath: string): string | undefined {
    const projectsDir = path.join(claudeDir, 'projects');
    const wanted = projectFolderName(workspacePath).toLowerCase();
    try {
        const match = fs.readdirSync(projectsDir).find(name => name.toLowerCase() === wanted);
        return match ? path.join(projectsDir, match) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Current Claude Code keeps a session's tasks in tasks/session-<first 8
 * characters of the session id>/<id>.json; older builds used tasks/<session id>/.
 */
export function taskListDir(claudeDir: string, sessionId: string): string | undefined {
    for (const name of [`session-${sessionId.slice(0, 8)}`, sessionId]) {
        const dir = path.join(claudeDir, 'tasks', name);
        if (fs.existsSync(dir)) {
            return dir;
        }
    }
    return undefined;
}

function normalizeStatus(status: unknown): TodoStatus {
    return status === 'in_progress' || status === 'completed' ? status : 'pending';
}

export function readTasks(dir: string): Todo[] {
    const tasks: Todo[] = [];
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) {
            continue;
        }
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
            if (raw.status === 'deleted') {
                continue;
            }
            tasks.push({
                id: String(raw.id ?? path.basename(file, '.json')),
                content: raw.subject ?? raw.content ?? '',
                description: raw.description,
                status: normalizeStatus(raw.status),
                activeForm: raw.activeForm,
                blockedBy: Array.isArray(raw.blockedBy) ? raw.blockedBy.map(String) : [],
            });
        } catch {
            // A task file caught mid-write; the watcher fires again once it lands.
        }
    }
    return tasks.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
}

function newestMtime(dir: string): number {
    let newest = 0;
    for (const file of fs.readdirSync(dir)) {
        newest = Math.max(newest, fs.statSync(path.join(dir, file)).mtimeMs);
    }
    return newest;
}

/** The session's name: a user-set title or agent name wins over the generated one. */
function readTitle(transcript: string): string | undefined {
    let fd: number | undefined;
    try {
        fd = fs.openSync(transcript, 'r');
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, TITLE_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        let named: string | undefined;
        let generated: string | undefined;
        for (const line of buffer.toString('utf-8').split('\n')) {
            if (!line.includes('title') && !line.includes('agent-name')) {
                continue;
            }
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'custom-title' && entry.customTitle) { named = entry.customTitle; }
                if (entry.type === 'agent-name' && entry.agentName) { named = entry.agentName; }
                if (entry.type === 'ai-title' && entry.aiTitle) { generated = entry.aiTitle; }
            } catch {
                // The first line of the tail window is usually a partial line.
            }
        }
        return named ?? generated;
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}

/**
 * Picks the session to show for a workspace: among its most recent
 * transcripts, the one whose task list changed last. Several sessions often
 * run in one workspace, and the newest transcript is not always the one doing
 * tracked work. Falls back to the newest transcript when none has tasks.
 */
export function loadCurrentSession(claudeDir: string, workspacePath: string): SessionData | undefined {
    const projectDir = findProjectDir(claudeDir, workspacePath);
    if (!projectDir) {
        return undefined;
    }
    const transcripts = fs.readdirSync(projectDir)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => {
            const file = path.join(projectDir, name);
            return { sessionId: path.basename(name, '.jsonl'), file, mtime: fs.statSync(file).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, RECENT_SESSIONS);
    if (transcripts.length === 0) {
        return undefined;
    }

    let chosen = { ...transcripts[0], tasksDir: undefined as string | undefined, updated: transcripts[0].mtime };
    let bestTaskChange = -1;
    for (const t of transcripts) {
        const tasksDir = taskListDir(claudeDir, t.sessionId);
        if (!tasksDir) {
            continue;
        }
        const changed = newestMtime(tasksDir);
        if (changed > bestTaskChange) {
            bestTaskChange = changed;
            chosen = { ...t, tasksDir, updated: changed };
        }
    }

    const todos = chosen.tasksDir ? readTasks(chosen.tasksDir) : [];
    return {
        sessionId: chosen.sessionId,
        projectPath: workspacePath,
        summary: readTitle(chosen.file),
        taskCount: todos.length,
        completedCount: todos.filter(t => t.status === 'completed').length,
        modified: new Date(chosen.updated).toISOString(),
        todos,
    };
}
