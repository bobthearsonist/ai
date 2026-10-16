---
name: git-commit-style
description: Conventional Commits format for git commit messages. Use when creating commits, writing commit messages, or reviewing commit history for style consistency.
---

# Conventional Commits

**Spec:** [conventionalcommits.org](https://www.conventionalcommits.org/)

## Format

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

## Types

| Type       | When to Use                                 |
| ---------- | ------------------------------------------- |
| `feat`     | New feature                                 |
| `fix`      | Bug fix                                     |
| `chore`    | Maintenance, dependencies, config           |
| `refactor` | Code restructuring (no behavior change)     |
| `docs`     | Documentation only                          |
| `test`     | Adding or updating tests                    |
| `ci`       | CI/CD changes                               |
| `style`    | Formatting, whitespace (not CSS)            |
| `perf`     | Performance improvement                     |
| `build`    | Build system or external dependency changes |
| `revert`   | Reverting a previous commit                 |

## Rules

- Type is **required**, scope is optional
- Description must be lowercase, imperative mood ("add" not "added" or "adds")
- Keep the first line under 72 characters
- Use body for additional context when needed
- Add `BREAKING CHANGE:` footer or `!` after type for breaking changes

## Examples

```
feat(auth): add OAuth2 login flow
fix: resolve null reference in user lookup
chore: update dependency versions
refactor(api): extract validation into middleware
docs: add setup instructions to README
feat!: drop support for Node 14
```
