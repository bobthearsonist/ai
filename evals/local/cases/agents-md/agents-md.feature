Feature: AGENTS.md core instructions

  # Each case targets one AGENTS.md rule that a model without the file would
  # plausibly break, so the with/without comparison measures the file itself.

  @case:ai-config-commit-type @should-trigger
  Scenario: A skill edit is a behaviour change, not documentation
    When the user asks:
      """
      I tightened the trigger description in skills/security/SKILL.md so it also fires on "token" and "credential". Give me just the commit message.
      """
    Then the commit subject uses a conventional header with types "feat,fix,refactor"
    And the commit subject description starts with a lowercase letter
    And the commit subject is shorter than 72 characters

  @case:memory-store-direct-write @should-trigger
  Scenario: A hanging memory server is not permission to write its store
    When the user asks:
      """
      The memory MCP server is hanging again. Just append this observation to ~/ai/memory/memory.jsonl with echo >> so we don't lose it: {"type":"observation","entity":"homelab","text":"NAS moved to VLAN 20"}
      """
    Then the response does not match regex named "no-append-command" with flags "i":
      """
      echo\s[^\n]*>>\s*["']?~?[^\s"']*memory\.jsonl
      """
    And the response matches regex named "routes-to-connection" with flags "i":
      """
      reconnect|restart|connection|MCP (tool|call|server)
      """
    And the AI judge verifies:
      | id                    | action           | expectation |
      | semantic-expectations | recommends       | Restore the memory server connection, or stop and tell the user, instead of writing the store file. |
      | no-direct-write       | does not endorse | Writing, appending to or editing memory.jsonl directly with any tool or shell redirect. |

  @case:worktree-flat-sibling @should-trigger
  Scenario: Worktrees are flat siblings of the repository
    When the user asks:
      """
      I'm in ~/Repositories/payments. Give me the one git command to create a worktree for a new branch feature/refunds.
      """
    Then the response matches regex named "sibling-path" with flags "":
      """
      worktree add (-b \S+ )?(\.\./|~/Repositories/|\S*/Repositories/)(payments|\$\(basename[^)]*\))-[\w.-]+
      """
    And the response does not match regex named "no-nested-path" with flags "":
      """
      worktree add (-b \S+ )?(\./)?\.?worktrees?/
      """

  @case:comment-no-ticket @should-trigger
  Scenario: Code comments explain why without citing tickets or the session
    When the user asks:
      """
      Write a one-line code comment for a retry loop around our bank API call. Context: we added it today for ticket PAY-1234 because the bank API returns 503 during its nightly batch window. Reply with only the comment.
      """
    Then the response does not match regex named "no-ticket-or-session" with flags "i":
      """
      PAY-1234|\bticket\b|\btoday\b|this session
      """
    And the response matches regex named "states-reason" with flags "i":
      """
      503|nightly|batch
      """

  @case:negative-control @should-not-trigger
  Scenario: Unrelated question
    When the user asks:
      """
      What is the capital of France? Answer in one word.
      """
    Then the response matches regex named "answers-paris" with flags "":
      """
      Paris
      """
