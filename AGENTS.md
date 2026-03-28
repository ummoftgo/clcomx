# Project Memory

These rules are project-level working defaults for future agent sessions.

## Team Mobilization

- If the user's intent is not realistically solvable as a simple direct task, recruit additional teammates first and run shared analysis, research, and design discussion before implementation.
- If the same symptom has been addressed 3 or more times without resolution, stop patching directly and automatically mobilize teammates.

## Repeat-Failure Protocol

When the repeat-failure threshold is hit:

1. Summarize the failed attempts and the observed symptoms.
2. Analyze likely root causes from the current code and architecture.
3. Investigate similar cases, prior art, or adjacent projects.
4. Discuss how those findings apply to this codebase before making more code changes.

Do not continue iterative patching until that review loop is complete.
