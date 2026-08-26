---
"cognia-next": minor
---

Context read-out: honest per-runtime numbers, and an expandable breakdown of what is in the window

- The popover now reads window → latest turn → detailed analysis → actions, and every row keeps a value: a missing figure prints "—" instead of an empty column (the cache row was blank at every size because of a field-name mismatch).
- "Detailed analysis" is a collapsible section with a stacked share bar, per-category tokens and percentages, and expandable item lists (MCP tools, memory files, built-in tools, subagents, skills, system-prompt sections). It says whether the numbers are live (SDK-reported) or estimated from the transcript.
- Unknown is no longer rendered as zero. A runtime that reports no usage shows a dashed ring and "—" rather than "0%", and the estimate path no longer draws free space it never measured.
- Auto-compaction is resolved instead of asserted: the CLI's own threshold and on/off state when reported, and "compaction is managed by the agent" (with "Compact now" disabled) for external-agent turns, which own their own context.
- External-agent turns now carry their token accounting into the transcript, so the agent's own context occupancy and window size drive the read-out instead of a guess from the model table.
