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
    And the AI judge confirms "semantic-expectations":
      """
      Pass only if the answer compares before and after using size, coupling, cohesion and testability,
      explains that smaller files alone do not prove improvement, and uses or proposes the skill's
      four-dimension composite out of 20. Equivalent explanations of dependency burden, responsibility
      focus and ease of testing count; literal rubric vocabulary is not required. Do not require
      invented measurements absent from the prompt. Fail if it equates reduced file length with
      demonstrated lower complexity or omits a dimension.
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
    And the AI judge confirms "semantic-expectations":
      """
      Pass only if the answer assesses size, coupling, cohesion and testability, relates the rating to
      the stated responsibilities/dependencies/testing difficulty, and gives a coherent composite out of
      20. Accept equivalent descriptions and reasonable ratings because the prompt does not determine
      one exact score. Fail if it invents source measurements, provides only an unexplained number, or
      treats the design as low complexity without addressing the stated problems.
      """
