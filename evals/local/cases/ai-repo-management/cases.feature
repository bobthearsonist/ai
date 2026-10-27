Feature: ai-repo-management skill evaluation

  @case:confusable-commit-draft @should-not-trigger
  Scenario: confusable commit draft
    When the user asks:
      """
      Draft a one-line commit message for adding a setup guide to the docs folder. Just the message, nothing else.
      """
    Then the response matches regex named "message" with flags "i":
      """
      docs: add setup guide
      """
    And the response does not match regex named "no-registry-advice" with flags "i":
      """
      collections\.private
      """
    And the response does not match regex named "no-command" with flags "i":
      """
      git commit
      """

  @case:edit-through-link @should-trigger
  Scenario: edit through link
    Given the suite fixtures are available
    When the user asks:
      """
      Read {{fixtures}}\scenario.md first, then the files under {{fixtures}} (home\AI and home\Repositories there stand in for ~/AI and ~/Repositories). I found a typo in ~/AI/skills/incident-response/SKILL.md. Answer in your reply: which file should I edit, and how does the fix reach my clients?
      """
    Then the response matches regex named "working-clone" with flags "i":
      """
      Repositories[/\\]company-ai[/\\]skills[/\\]incident-response
      """
    And the response matches regex named "reaches-main" with flags "i":
      """
      \b(merge[sd]?|push(ed)?|pull request)\b
      """
    And the response matches regex named "next-sync" with flags "i":
      """
      sync\.sh|re-?sync|next sync
      """
    And the AI judge verifies:
      | id                    | action           | expectation |
      | semantic-expectations | identifies       | The company-ai working clone's skills/incident-response/SKILL.md is the source to edit; equivalent paths are acceptable. |
      | shared-branch         | explains         | The change reaches the shared branch through the repository's normal review and merge workflow; equivalent phrasings count. |
      | client-sync           | explains         | A subsequent sync distributes the change to clients; judge the explanation, not evidence that commands actually ran. |
      | no-generated-copy     | does not endorse | Editing a generated client copy or presenting a local edit as already distributed. |

  @case:explicit-registration @should-trigger
  Scenario: explicit registration
    Given the suite fixtures are available
    When the user asks:
      """
      Using the ai-repo-management skill: read {{fixtures}}\scenario.md first, then the files under {{fixtures}} (home\AI, home\Repositories\ai-private there stand in for ~/AI and ~/Repositories/ai-private). Answer in your reply: propose how to register the git-commit-style skill in the private collection registry, and the exact sync command to run afterwards.
      """
    Then the response matches regex named "path" with flags "i":
      """
      Repositories/ai-private/skills/git-commit-style
      """
    And the response matches regex named "registry-key" with flags "i":
      """
      collections\.private\.skills|private:[\s\S]{0,120}skills:
      """
    And the response matches regex named "sync-command" with flags "i":
      """
      \./scripts/sync\.sh
      """
    And the response does not match regex named "no-push-command" with flags "i":
      """
      `git push
      """

  @case:implicit-missing-discovery @should-trigger
  Scenario: implicit missing discovery
    Given the suite fixtures are available
    When the user asks:
      """
      Read {{fixtures}}\scenario.md first, then the files under {{fixtures}} (home\AI, home\Repositories\ai-private there stand in for ~/AI and ~/Repositories/ai-private). My git-commit-style skill never shows up in my AI client. Diagnose why and say what to change and run. Answer in your reply.
      """
    Then the response matches regex named "registry-key" with flags "i":
      """
      collections\.private\.skills|private:[\s\S]{0,120}skills:
      """
    And the response matches regex named "names-skill" with flags "i":
      """
      git-commit-style
      """
    And the response matches regex named "sync-command" with flags "i":
      """
      \./scripts/sync\.sh
      """

  @case:negative-greeting @should-not-trigger
  Scenario: negative greeting
    When the user asks:
      """
      Write one welcome sentence for a visitor arriving at a community garden.
      """
    Then the response matches regex named "welcomes" with flags "i":
      """
      welcome
      """
    And the response does not match regex named "no-registry-advice" with flags "i":
      """
      local\.yaml
      """

  @case:private-remote-placement @should-trigger
  Scenario: private remote placement
    Given the suite fixtures are available
    When the user asks:
      """
      Read {{fixtures}}\scenario.md first, then the files under {{fixtures}} (home\AI and home\Repositories there stand in for ~/AI and ~/Repositories). I want every AI client to load the release-checklist skill from my company's private repo git@ssh.example.com:acme/ops-ai, where it lives at skills/release-checklist. I already have a clone of it at ~/Repositories/ops-ai. Answer in your reply: the exact registry change and the command to run afterwards.
      """
    Then the response matches regex named "local-registry" with flags "i":
      """
      local\.yaml
      """
    And the response matches regex named "clone-path" with flags "i":
      """
      Repositories[/\\]ops-ai(?![-\w])
      """
    And the response matches regex named "sync-command" with flags "i":
      """
      sync\.sh
      """
    And the response does not match regex named "no-private-manifest-source" with flags "i":
      """
      source:\s*["']?(git@|ssh://)
      """
