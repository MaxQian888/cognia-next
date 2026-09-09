---
"cognia-next": minor
---

A top-level chat on a provider that runs on the AI SDK rail (anything other than Anthropic) now gets the `dispatch_agent` tool without first enabling subagent nesting or entering plan mode. That rail has no native Task tool, so the model previously had no way to delegate to Explore, Plan, Code Reviewer or the user's own agents there.
