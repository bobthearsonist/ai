# AI repository management pilot

Source-owned suite; never copy this directory into a skill/plugin payload.
The target is the canonical `ai\skills\ai-repo-management`, installed by the
actual client adapter from the candidate or separately human-approved baseline
snapshot. No operational baseline is supplied or approved here.

| Case | Claude Code | OpenCode | Copilot | Target discovery requirement |
| --- | --- | --- | --- | --- |
| explicit-registration | required | required | required | actual skill load |
| implicit-missing-discovery | required | required | required | actual skill load |
| negative-greeting | required | required | required | no target load; complete discovery audit |
| confusable-commit-draft | required | required | required | no target load; complete discovery audit |

Confusable drafting legitimately matches the real `git-commit-style` distractor.
Its loading is allowed, not a substitute for auditing absence of the target.
Implicit diagnosis must identify an unregistered existing source, not merely
recite general advice. Positive cases intentionally evaluate proposed repairs,
not mutations of a source repository or real user configuration.

## Context and trust boundaries

`suite.json` declares every provided input file and the intentionally unavailable
remote services. Home fixtures are synthetic summaries of source documentation,
not copied personal registries/settings. The distractor is a full canonical
source skill copy, normalized only for line endings.

`mountRoot: "home"` resolves `mount` under the **fresh isolated HOME**;
`mountRoot` defaults to workspace otherwise. Do not implement a magic `home/`
prefix or fall back to the developer profile. The synthetic private repository
must exist; the generated `~/AI/skills/git-commit-style` link must initially be
absent. Root containment, collision checks, and home materialization are adapter
prerequisites, not proven by suite validation.

`kind: distractor-skill` requires real client discovery installation, not an
ordinary workspace document or injected prompt. Keep distractors and context
identical across candidate/baseline/optional no-skill arms. Omit only the target
in the no-skill diagnostic. Do not load a developer's global catalog.

Contract version 2 uses deterministic checks only, with no AI judge, rubric,
quality score, quality mean, or manual-quality gate. This suite needs no
grader-private runtime dependency. Never mount this README, `pilot.test.mjs`,
`fixtures\specimens.json`, or suite check declarations into either task arm;
send only the case prompt and explicitly agent-visible context. Specimens are
fixed good/broken artifact text for objective unit tests, not agent input.
Shared `loadSuite` produces per-case fixture hashes covering prompt, checks
and declared context.

## Offline checks

From `C:\Repositories\ai\evals`:

```powershell
node harness\cli.mjs validate --suite suites\ai-repo-management\suite.json --profile tests\fixtures\profile.json
node harness\cli.mjs dry-run --suite suites\ai-repo-management\suite.json --profile tests\fixtures\profile.json
node --test suites\ai-repo-management\pilot.test.mjs
```

The test command validates all three approved sibling-source pilots through the
shared contract and proves each good/broken specimen discriminates
using the declared literal artifact checks. It writes nothing, makes no client,
provider, Git, or service calls, and asserts each client's complete matrix.
The shared profile is explicitly **offline test data**, not production pins.

Default dry-run: **4 cases × 3 clients × 2 arms × 3 fresh repeats = 72 sessions**.
Single-client selection is 24; adding optional no-skill is 108. Native plugin
trials are not included. Three suites total 216 default sessions.
Dry-run enumerates every coordinate; it does not execute them or approve a
baseline. Reports use deterministic check/discovery outcomes and counts, not
quality means. Authentic trigger evidence and the complete candidate versus
exact human-approved baseline matrix remain live-adapter requirements.
Literal checks do not prove a whole-system no-mutation boundary; isolation must
enforce that separately.

## Live execution boundary

Use the shared README's native client-login procedures for Claude Code,
OpenCode and Copilot; the grader requires no judge API key or provider call.
Task execution still requires each real client's valid native login and
explicitly approved baseline/client configuration. Offline fixture pins are
not operational approval. Clients must actually write `answer.md`; stdout is
not a substitute for that artifact. Three fresh isolated repeats per arm and
client, real discovery events, and required correctness/safety checks are
mandatory. No live-provider acceptance is claimed by these offline tests.
