---
"cognia-next": minor
---

Add the built-in Config Governance plugin: it audits your instruction files, agent files, Skills, characters, templates and prompt overrides for dated, conflicting and stale rules, replays past sessions to show which rules are actually followed, can enforce a rule with a tool-call reminder or block, and compares adherence and eval results before and after a change. Plugins can read agent configuration through the new `ctx.agentConfig` and write changes back with per-surface confirmation; a plugin's deny reason now reaches the agent, and the Prompt Center opens a resource from a link.
