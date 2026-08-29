---
"cognia-next": patch
---

Built-in tools: four categories you could switch on in the app but not in the CLI, and one switch that existed only in the CLI.

`codeGraph`, `astGrep`, `dependencyResearch` and `webclone` worked at runtime everywhere — the CLI's tool host gates on the category generically — but the CLI had no way to enable them: its config schema is strict and did not list them, its `/settings` panel had no rows, `/tools` did not document them, and the CLI↔App bridge dropped them, so switching one on in Settings → Tools and pushing to the CLI reported success and sent nothing. All four are now offered and pushed.

Going the other way, Settings → Tools now offers "Core file tools on Anthropic". It is a modifier on the core file suite rather than a category of its own, so the page's category walk never rendered it, even though the CLI has always offered it and the bridge pushes it across.

All of these surfaces now derive from one list, so a new category cannot reach one and not the other.
