---
"cognia-next": minor
---

Let the app drive a workbench that is not on this machine. Nine `codeserver_agent_*` verbs, `open_file`, and the settings and argv readers and writers were classified as local-only commands, so a desktop pointed at a remote host sent every one of them to itself: agent open, diff, reveal, save-all and run-in-terminal silently did nothing, and the theme and language sync repainted the local `settings.json` while the remote workbench kept stock VS Code colours. All fourteen now execute on the host that owns the workbench, on both a headless host and a paired desktop. A companion can also discover that a host runs Pro IDE at all, and start or stop its workbench, which no surface could do before.
