# AI Guild Teams draft

Attach `ai-guild-evals.html` after reviewing it. This message has not been posted.

---

**Skill evals: does a skill actually help, or just add instructions?**

We've put together a local workflow that runs realistic prompts with and without
a skill, checks observable outcomes deterministically, and keeps the traces.
Deterministic scores do not use an LLM judge; a separately opt-in AI judge can
write separate 50/50 deterministic and semantic scores without changing original history. The attached HTML
covers setup, cases, results and safety boundaries. Nine positive cases have
meaning-based rubrics for this separate judge path; no new live measurements
or accuracy improvement is claimed.

**TL;DR:** start with offline Gherkin validation and dry-run planning. All 22
existing cases across six suites have been migrated to Gherkin. ACP is now the
only transport; legacy execution, replay and JSON case compatibility are removed.
Native profiles isolate configuration and restrict tools; there is no native/SDK
fallback. Bounded Claude candidate and advisory-judge smokes have completed,
but cross-client acceptance and judge accuracy remain unproven. Multi-runner
selection is implemented in the engine on `main`, installed at a reviewed Git
commit without a sibling checkout. OpenCode is not implemented.
Historical local archives were deleted during cleanup; any fresh live run needs
its own explicit model and exact session approval. This is an early walkthrough,
not a ready-for-all-runners launch.

[Shared engine: ai-evals](https://github.com/bobthearsonist/ai-evals)
| [Cases, fixtures and config: ai/evals](https://github.com/bobthearsonist/ai/tree/main/evals)

Use synthetic/non-sensitive inputs and approve the planned live-session count.
Runs consume subscription allowance; don't post raw traces or credentials.
