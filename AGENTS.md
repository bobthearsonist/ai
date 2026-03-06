# AI Agent Instructions

## Session Startup (MANDATORY - every conversation)

Complete these steps IN ORDER before responding to any request:

1. **Read todo list** - Check for existing tasks from previous sessions
2. **Check memory** - Search for relevant stored context
3. **Evaluate skill promotion** - Entity has 10+ observations? Load `skill-promotion` skill and suggest promoting
4. **Check skills** - Before infrastructure/CLI commands, search skills for documented procedures
5. **Create/update task list** - If request involves 2+ steps or any code changes
6. **Use sequential thinking** - For debugging, architecture, or multi-file changes

This applies even if a session summary is provided. Summaries may be stale.

---

## Anti-Patterns

| Never do this | Do this instead |
|---|---|
| Skip startup steps because "I have context" | Always run the checklist - todo state may differ from summary |
| Debug without sequential thinking | Think systematically before acting |
| Let task list go stale | Update status immediately after each step |
| Suggest `--interactive` or browser-spawning in elevated PowerShell | These freeze the shell - use non-interactive alternatives |
| Repeat a failed approach | Stop after first failure, rethink, try a different approach |
| Guess at CLI/infrastructure commands | Check skills first - they contain tested syntax |
| Run broad glob patterns (`**/*.ts` from root) | Ask user to narrow scope or use grep instead |
| Tail or stream long-running commands (builds, tests, docker) | Pipe to a temp file and read it after completion (see Long-Running Commands) |
| Redirect to `/dev/null` or `$null` (triggers file-write approval prompts) | Omit the redirect (output is useful context), or use `--quiet`/`-q` flags |

## Task Management

Create a task list for any work with 2+ steps. Rules:

- Create todos BEFORE starting work
- Only ONE todo `in-progress` at a time
- Mark `completed` IMMEDIATELY after finishing (don't batch)

---

## Memory

Use the persistent memory system actively.

| Trigger | Action |
|---|---|
| Start of any conversation | Search for relevant context |
| User states a preference | Store immediately |
| You learn something reusable | Store it |
| You solve a tricky problem | Store the solution pattern |
| End of significant work | Store learnings |

**What to store**: user preferences, project context, architecture decisions, recurring fix patterns, entity relationships.

---

## Sequential Thinking

**Mandatory triggers** - use structured thinking when:

- Debugging any error or unexpected behavior
- Planning changes to 2+ files
- Answering "why" or "how" questions requiring analysis
- Architecture or design decisions
- Any task requiring 3+ logical steps

---

## RAG Search (Qdrant)

Search Qdrant indexes before broad codebase exploration:

| Collection | Tool | Content |
|---|---|---|
| `code` | `qdrant-code_qdrant-find` | Indexed Git repo source code |
| `work` | `qdrant-work_qdrant-find` | Obsidian work work notes |

**When to search**:
- Before broad grep/glob searches across unfamiliar code -- search `qdrant-code` first to narrow scope
- When looking for architecture decisions, meeting notes, or project context -- search `qdrant-work`
- When the user asks about a feature, component, or pattern you haven't seen yet

**How to search**: Use semantic natural language queries, not exact keyword matches. Example: "authentication middleware for REST API" not "auth".

---

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/). Constraints:

- Imperative mood, lowercase description (e.g., "add" not "added")
- First line under 72 characters
- `BREAKING CHANGE:` footer or `!` after type for breaking changes

Examples:
```
feat(auth): add OAuth2 login flow
fix: resolve null reference in user lookup
refactor(api): extract validation into middleware
feat!: drop support for Node 14
```

---

## Worktree Directory

Create worktrees at c:/Repositories/<project-name>.worktrees/<branch-name>

---

## Triggered Workflows

The following workflows activate only when their trigger condition is met.

### Permissions YAML Sync

**Trigger**: Adding/suggesting auto-approve commands or configuring MCP tool permissions.

Load `permissions-yaml` skill, update `~/ai/permissions/permissions.yaml`, and remind user to sync to other clients.

### Context Compacting

**Trigger**: Approaching token limits, user requests compact, or agent suggests it.

Before compacting:
- Save new learnings, patterns, and solutions to memory
- Complete or document any open thinking chains
- Update todo list (mark completed, note progress on in-progress items, capture blockers)

After compacting: read memory, check todo list, resume work.

### End of Session

**Trigger**: All todos completed, user says "done"/"wrapping up", or context compact is imminent.

Load `obsidian-notes` skill and append a session summary. When the last todo is marked completed, always trigger this - do not skip.
