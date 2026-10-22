# AI Guild Teams draft

Attach `ai-guild-evals.html` after reviewing it. This message has not been posted.

---

**Skill evals: does a skill actually help, or just add instructions?**

We've put together a local workflow that runs realistic prompts with and without
a skill, checks observable outcomes deterministically, and keeps the traces.
Deterministic scores do not use an LLM judge; a separately opt-in AI judge can
write advisory assessments without changing those scores. The attached HTML
covers setup, cases, results and safety boundaries. Nine positive cases have
meaning-based rubrics for this separate judge path; no live judge calibration
or accuracy improvement is claimed.

**TL;DR:** start with offline Gherkin validation and dry-run planning. All 22
existing cases across six suites have been migrated to Gherkin. Both default
adapters now use ACP, but native candidate runs remain blocked until required
skill/MCP isolation is verified; there is no native/SDK fallback.
A historical native Claude smoke passed and offline regrading matched;
that verifies the old path, not ACP or skill lift. Multi-runner selection is implemented in
the local development engine but is not released or in the consumer's pinned
dependency yet. One experimental Copilot SDK smoke now completed with a valid
receipt, captured usage and clean skill/MCP audits; offline regrading matched
its 0.75 score. The score is below threshold because a header-length check
failed, so this is not a passing case or evidence of skill lift. This single
local result does not make Copilot generally launch-ready; OpenCode is not
implemented. This is an early walkthrough, not a ready-for-all-runners launch.

[Shared engine: ai-evals](https://github.com/bobthearsonist/ai-evals)
| [Cases, fixtures and config: ai/evals](https://github.com/bobthearsonist/ai/tree/main/evals)

Use synthetic/non-sensitive inputs and approve the planned live-session count.
Runs consume subscription allowance; don't post raw traces or credentials.
