Feature: pattern-principles skill evaluation

  @case:incremental @should-trigger
  Scenario: incremental
    When the user asks:
      """
      Review this plan: introduce Repository, Unit of Work and CQRS across all 20 services in a single PR.
      """
    Then the response matches regex named "splits-the-work" with flags "i":
      """
      (separate|multiple|several|smaller|individual|one per|one) (PRs?|pull requests?|changes?|changesets?)|one (pattern|module|service) (at a time|per)|incremental|phase[ds]?\b
      """
    And the response matches regex named "asks-for-pain-evidence" with flags "i":
      """
      \bpain\b|evidence|file:line|concrete (problem|need|pain)|what (problem|pain)|justif|which services? (actually|really)
      """
    And the AI judge confirms "semantic-expectations":
      """
      Pass only if the answer challenges the broad rewrite, recommends smaller independently justified
      changes or a bounded pilot, and asks for concrete evidence of the design problems each pattern
      would solve. A particular keyword such as 'pain' or 'incremental' is not required; accept clear
      equivalent reasoning anywhere in the answer. Fail if it endorses the blanket introduction without
      problem evidence or presents all three patterns as mandatory.
      """

  @case:negative-control @should-not-trigger
  Scenario: negative control
    When the user asks:
      """
      Explain what the Observer pattern is in two sentences.
      """
    Then the response matches regex named "explains-observer" with flags "i":
      """
      subject|notif|subscrib
      """

  @case:pain-gate @should-trigger
  Scenario: pain gate
    When the user asks:
      """
      Our OrderService has three if-statements on payment type. Tests pass and it reads fine. Should I introduce Strategy plus a factory and registry now, just to be safe?
      """
    Then the response matches regex named "wants-evidence-of-pain" with flags "i":
      """
      \bpain\b|evidence|\bmeasure|file:line|concrete (problem|need|pain)|actual(ly)? (cause|caus|hurt)
      """
    And the response matches regex named "advises-against-now" with flags "i":
      """
      leave (it|this|the code)( alone| as[- ]is)|(don'?t|do not|no need to|not worth|wouldn'?t|i'?d (not|skip))[\s\S]{0,40}(introduc|add|adopt|refactor|use strategy)|keep (it|them|the (if|code))[\s\S]{0,20}(as is|simple|for now)|not (yet|now)|hold off|premature
      """
    And the AI judge confirms "semantic-expectations":
      """
      Pass only if the answer advises against adding that machinery now, ties the advice to the absence
      of demonstrated maintenance/testing/change problems, and makes later refactoring conditional on
      concrete evidence of need. Equivalent phrasing counts even when the recommendation and rationale
      are far apart. Fail if it recommends adding the abstractions just in case, or says never to
      refactor regardless of future evidence.
      """
