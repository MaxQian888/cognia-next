---
"cognia-next": minor
---

`Explore` and `Plan` are one agent each again. The app and the CLI used to ship their own copy of both, with different prompts and different descriptions, so the same name meant a different agent depending on which shell dispatched it. Both now read one shared catalog, and each prompt is the merged text: the concrete working guidance the app's version carried, plus the leaf and no-follow-up constraints the CLI's version stated.

Team sessions gain the `general-purpose` agent, which previously existed only in the CLI, so a coordinator can delegate an open-ended task without a purpose-built teammate. It is deliberately not added to ordinary chat.

A subagent template you author with the same name as a built-in now replaces that built-in instead of appearing beside it under a second name. Plugin-contributed subagents keep their `<pluginId>:` namespace, so a plugin still cannot claim a built-in's name.
