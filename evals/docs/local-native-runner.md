# Local native eval runner

The engine has moved to [ai-evals](https://github.com/bobthearsonist/ai-evals).
See its README for the case schema, adapter contract, installation and result
semantics. The commit-pinned dependency routes Claude and Copilot through
ACP exclusively, without a native/SDK fallback. Candidate profiles use sterile
homes, read-only tools and controlled skill workspaces; machine-managed Claude
policy is refused. Bounded Claude ACP candidate and judge smokes have completed;
cross-client live acceptance remains pending.
A historical SDK-driven Copilot smoke completed with a valid
receipt, captured usage and clean runtime MCP/skill audits; offline regrading
matched its 0.75 score. The score is below threshold because one header-length
check failed, so this is pipeline/isolation evidence rather than a passing case
or skill-lift result; it does not validate the ACP path. OpenCode remains unimplemented.
The development engine no longer executes or regrades native/SDK archives;
historical artifacts remain unchanged.

The pinned engine includes a Gherkin/JSON shared
assertion layer, capability-gated ACP transport and a separately approved AI
judge. All six suites (22 cases) use Gherkin; `npm ci --ignore-scripts` installs
the engine at the Git commit in `package.json`. Its whole-subject length policy is
an intentional correction to the former suffix-length regex. See the
[suite migration and policy mapping](../README.md#gherkin-suites) before
comparing scores or running the repository tests. No sibling engine checkout
is required.

This repository owns the cases, fixtures and artifacts. Start with the
[evals README](../README.md) for local commands and
[repository-specific notes](../../docs/local-native-runner.md) for case quality,
traces and configuration.

The [AI Guild onboarding page](ai-guild-evals.html) includes a quick start,
historical smoke evidence and the commit-pinned installation procedure.
