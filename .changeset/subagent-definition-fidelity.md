---
"cognia-next": minor
---

Subagents: agent files under `.cognia/agents` now honor every field they declare in the CLI (`maxTurns`, `effort`, `disallowedTools`, `allowNesting`, `maxDepth`, external presets), and a `color:` frontmatter tints the agent's rows in the terminal. Dispatched subagents in both shells receive an environment block (working directory, platform, date) and the dispatched-subagent contract in their system prompt.
