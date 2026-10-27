Feature: code-anti-patterns skill evaluation

  # guard: a strong baseline also names this well-known smell, so no lift is expected
  @case:god-object @should-trigger
  Scenario: god object
    When the user asks:
      """
      OrderManager has 40 methods covering validation, persistence, email and PDF rendering. What is the smell?
      """
    Then the response matches regex named "names-god-object" with flags "i":
      """
      god[\s-]?(object|class)|\bblob\b
      """
    And the response matches regex named "splits-by-responsibility" with flags "i":
      """
      (split|extract|separate|break)[\s\S]{0,80}(class|service|component|object|responsibilit|reasons? (to|for) chang)|single[- ]responsibility
      """
    And the AI judge verifies:
      | id                        | action           | expectation |
      | semantic-expectations     | identifies       | Excessive, unrelated responsibilities are the problem; accept God Object, God Class, Blob, or a clear equivalent explanation without requiring a specific smell name. |
      | cohesive-responsibilities | recommends       | Separate cohesive responsibilities to address the stated problem, not merely rename the class or split it by arbitrary line counts. |
      | responsibility-concentration | does not endorse | Keeping the current concentration without addressing the stated responsibility problem. |

  @case:negative-control @should-not-trigger
  Scenario: negative control
    When the user asks:
      """
      Write a Python function that reverses a string.
      """
    Then the response matches regex named "has-function" with flags "":
      """
      def \w+
      """

  @case:shotgun-surgery @should-trigger
  Scenario: shotgun surgery
    When the user asks:
      """
      Every time we add a new currency we have to edit 14 files across 6 packages. What is wrong with our design?
      """
    Then the response matches regex named "names-shotgun-surgery" with flags "i":
      """
      shotgun surgery
      """
