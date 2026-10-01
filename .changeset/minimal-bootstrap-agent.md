---
"cognia-next": minor
---

Add a standalone bootstrap Agent for small tasks and environment initialization,
with shell and text editing, bounded execution, explicit readiness checks, and
optional configuration in project environment settings. Ship the executable
with desktop and container bundles before the full Agent runtime starts.

Expand the utility with interactive chat, resumable complete-turn sessions,
manual and automatic compaction, overflow recovery, DSH-compatible Bash/editor
tools and streamed response transport. Allow custom model endpoints, request
parameters, authentication/header references, personas, tool grants, shell
settings, context policies and output budgets through CLI and environment UI.

Add native, independently copyable Bash and PowerShell Agents with matching configuration,
sessions, model/tool customization and initialization behavior. Select the
runtime in environment settings, including PowerShell on Windows, and validate
both scripts against a shared local-provider acceptance suite. Bash uses curl
and jq; PowerShell uses built-in modules and .NET APIs, without an embedded
Python or C# engine.

Add shared provider/task presets, initialization recipes and ordered custom
preset files. Expose offline diagnostics, authenticated model discovery and
in-chat model switching in both scripts. Apply editable presets in Cognia's
environment settings, clearing old provider authentication and saving recipe
setup/readiness settings together. Preserve privacy checks while avoiding false
passport matches caused by JSON newline escapes before file offsets.
