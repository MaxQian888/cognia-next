---
name: find-skills
description: >-
  Discover an existing project, installed, or installable skill for a requested
  capability. Use when the user asks whether a skill exists, wants to extend
  Codex, or needs a reusable workflow not covered by the current skill set.
---

# Find Skills

Prefer the closest trusted skill and avoid installing duplicate capability.

## Workflow

1. **Define the capability.** Reduce the request to a domain, concrete task,
   expected artifact, and any required integration.
2. **Search locally first.** Check the current session's available skills and
   `.agents/skills/`. Read only the candidate descriptions, then the selected
   `SKILL.md`. A project-native skill wins over a generic external equivalent.
3. **Check installed user skills.** Search the configured Codex skill roots
   before looking online. Distinguish a missing skill from a missing MCP/app or
   ordinary general-purpose work.
4. **Search the ecosystem when still missing.** Use a current skills catalog or
   `rtk pnpm dlx skills find <specific-query>`. Verify the source repository,
   recent maintenance, license, contents, and overlap with local skills. Treat
   install counts and popularity as time-sensitive signals, not proof of quality.
5. **Present the best options.** Give the name, why it fits, source, install
   scope, and material risks. Recommend at most three; include “do it directly”
   when a skill would add little value.
6. **Install only after explicit approval.** Use the available skill installer
   for skills. A named plugin uses the plugin installation flow only when the
   user explicitly requested that plugin and no callable capability is already
   available.
7. **Verify discovery.** Confirm the installed skill is in the expected root,
   validate its `SKILL.md`, and tell the user whether a restart/reload is needed.

If no suitable skill exists, offer to perform the task directly or create a
project-native skill with `skill-creator` when the workflow is genuinely reusable.
