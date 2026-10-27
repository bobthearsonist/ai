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
    And the AI judge verifies:
      | id                    | action   | expectation |
      | semantic-expectations | explains | Compare before and after using size, coupling, cohesion, and testability; equivalent descriptions of dependency burden, responsibility focus, and ease of testing count. |
      | file-size-alone       | explains | Smaller files alone do not prove improved complexity; do not equate reduced file length with demonstrated lower complexity. |
    And the AI judge confirms "four-dimension-composite":
      """
      The answer uses or proposes the skill's four-dimension composite out of 20 to quantify before and after. Do not require invented measurements absent from the prompt.
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
    And the AI judge verifies:
      | id                    | action           | expectation |
      | semantic-expectations | explains         | Assess size, coupling, cohesion, and testability and relate the rating to the stated responsibilities, dependencies, and testing difficulty. |
      | composite-score       | explains         | Give a coherent composite rating out of 20; accept equivalent descriptions and reasonable ratings because the prompt does not determine one exact score. |
      | stated-evidence       | explains         | Ground the rating in facts provided by the prompt; do not invent source measurements or provide only an unexplained number. |
      | not-low-complexity    | does not endorse | Treating the design as low complexity without addressing the stated problems. |
