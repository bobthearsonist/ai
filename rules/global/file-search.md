# File Search Rules

## ⛔ STOP - Before ANY File Search

**Do NOT run glob or file searches until you have:**

1. Checked memory for previously learned project structure
2. Considered if you already know the file path (use `read` directly)
3. Considered if `grep` is better (searching for content, not filenames)
4. Constrained the search to a specific subdirectory

**If you don't know where files are located, ASK THE USER.**

---

## Tool Selection

| Goal                          | Correct Tool              | Wrong Tool                    |
| ----------------------------- | ------------------------- | ----------------------------- |
| Find files by content/pattern | `grep` with regex         | `glob **/*` then read each    |
| Read a known file             | `read` directly           | `glob` to find it first       |
| Find files by name            | `glob` with specific path | `glob **/*` from root         |
| Explore project structure     | Ask user                  | Recursive glob                |
| Find class/function def       | `grep "class Foo"`        | `glob` + read each file       |

---

## Glob Constraints (MANDATORY)

- **NEVER** use `**/*` or `**/*.ext` from repository root
- **ALWAYS** constrain to a subdirectory: `src/**/*.ts`, `lib/**/*.py`
- **PREFER** shallow patterns: `src/*.ts` over `src/**/*.ts`
- **EXCLUDE** heavy directories: `node_modules`, `.git`, `dist`, `build`
- **ASK** if you don't know the right subdirectory

---

## Anti-Patterns

| Don't Do This                              | Do This Instead                          |
| ------------------------------------------ | ---------------------------------------- |
| `glob **/*.ts` from root                   | Ask: "Where is your TypeScript source?"  |
| `glob **/*` to explore                     | Ask: "What's the project structure?"     |
| Glob to find a class definition            | `grep "class ClassName"`                 |
| Glob then read 20 files looking for code   | `grep "the code pattern"` first          |
| Multiple broad globs in sequence           | One targeted search based on user input  |

---

## Examples

**Bad:**
```
User: "Find where the auth logic is"
Agent: *runs glob **/*.ts, then reads 50 files*
```

**Good:**
```
User: "Find where the auth logic is"
Agent: "Is your auth code in a specific directory like src/auth or lib/auth?"
- OR -
Agent: *runs grep "authenticate\|authorization" --include="*.ts"*
```
