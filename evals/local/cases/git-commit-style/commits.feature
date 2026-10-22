Feature: Conventional commit messages

  @case:explicit-positive @should-trigger
  Scenario: Rename a function
    When the user asks:
      """
      Write me a commit message: renamed getUser to fetchUser, updated 3 call sites.
      """
    Then the commit subject uses a conventional header with types "feat,fix,chore,refactor,docs,test,ci,style,perf,build,revert"
    And the commit subject description starts with a lowercase letter
    And the commit subject is shorter than 72 characters

  @case:implicit-breaking @should-trigger
  Scenario: Drop an unsupported runtime
    When the user asks:
      """
      We dropped Node 14 support. Give me the commit line.
      """
    Then the commit subject uses a conventional header with types "feat,fix,chore,refactor,docs,test,ci,style,perf,build,revert"
    And the commit subject description starts with a lowercase letter
    And the response matches regex named "breaking-marker" with flags "":
      """
      (\)|[a-z])!: |BREAKING CHANGE
      """

  @case:negative-control @should-not-trigger
  Scenario: Explain a git operation without composing a commit
    When the user asks:
      """
      Explain what git rebase does in two sentences.
      """
    Then the response does not match regex named "no-commit-header" with flags "m":
      """
      ^[\s`]*(feat|fix|chore|refactor|docs|test|ci|style|perf|build|revert)(\([^)]+\))?!?: [a-z]
      """
