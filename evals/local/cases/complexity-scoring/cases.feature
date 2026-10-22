Feature: complexity-scoring skill evaluation

  @case:before-after @should-trigger
  Scenario: before after
    When the user asks:
      """
      I split a 900-line module into four modules of about 200 lines each. How do I quantify whether that improved things?
      """
    Then the response matches regex named "four-dimension-rubric" with flags "i":
      """
      ^(?=[\s\S]*\bsize\b)(?=[\s\S]*coupling)(?=[\s\S]*cohesion)(?=[\s\S]*testab)
      """
    And the response matches regex named "composite-score" with flags "i":
      """
      (out of|/)\s*20\b|\b4\s*(-|–|to)\s*20\b
      """

  @case:negative-control @should-not-trigger
  Scenario: negative control
    When the user asks:
      """
      What does cyclomatic complexity mean? One sentence.
      """
    Then the response matches regex named "mentions-paths" with flags "i":
      """
      path
      """

  @case:score-god-class @should-trigger
  Scenario: score god class
    When the user asks:
      """
      Rate the complexity of a 1,800-line UserManager class that handles auth, email, billing and direct database access, and is hard to unit test.
      """
    Then the response matches regex named "composite-out-of-20" with flags "":
      """
      \b\d{1,2}\s*/\s*20\b
      """
    And the response matches regex named "mentions-coupling" with flags "i":
      """
      coupling
      """
    And the response matches regex named "mentions-cohesion" with flags "i":
      """
      cohesion
      """
