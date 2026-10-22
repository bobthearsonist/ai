# Local native eval runner

The engine has moved to [ai-evals](https://github.com/bobthearsonist/ai-evals).
See its README for the case schema, adapter contract, installation and result
semantics. The installed dependency pin has unimplemented Copilot and OpenCode
adapters. The unreleased engine checkout routes both Claude and Copilot through
ACP exclusively, without a native/SDK fallback. Native candidate profiles refuse
execution until required skill/MCP isolation can be verified.
A historical SDK-driven Copilot smoke completed with a valid
receipt, captured usage and clean runtime MCP/skill audits; offline regrading
matched its 0.75 score. The score is below threshold because one header-length
check failed, so this is pipeline/isolation evidence rather than a passing case
or skill-lift result; it does not validate the ACP path. OpenCode remains unimplemented.
The development engine no longer executes or regrades native/SDK archives;
historical artifacts remain unchanged.

The development checkout now includes an unreleased Gherkin/JSON shared
assertion layer, capability-gated ACP transport and a separately approved AI
judge. All six suites (22 cases) now use Gherkin and need that checkout; the current published
dependency pin cannot load `.feature` files. Its whole-subject length policy is
an intentional correction to the former suffix-length regex. See the
[suite migration and policy mapping](../README.md#gherkin-suites-unreleased) before
comparing scores or running the repository tests. No dependency pin change,
publication or new live run is implied.

This repository owns the cases, fixtures and artifacts. Start with the
[evals README](../README.md) for local commands and
[repository-specific notes](../../docs/local-native-runner.md) for case quality,
traces and configuration.

The [AI Guild onboarding page](ai-guild-evals.html) includes a quick start,
verified smoke evidence and the distinction between the installed dependency
and unreleased checkout.
