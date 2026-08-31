---
"cognia-next": patch
---

Pro IDE no longer pretends the app can drive a remote workbench. Taking over a remote host leaves the embedded editor fully usable by hand, but every app-to-editor command is local-only, so agent open/diff/save silently did nothing and the theme and language sync quietly rewrote the local machine's settings instead of the one on screen. Those now stand down while a remote host is active, and the engine switch says so.

The Pro IDE settings card also stops answering "unsupported" to three different situations. A phone, a browser with nothing paired, and a desktop with no prebuilt binary for its platform now each get their own reason. It gained a running-state row naming the workspace the bound instance is serving, which finally gives `codeserver_status` a caller: it was the last entry on ADR-0088's own list of commands with none. And the "switching profile starts a separate VS Code" warning, written in both languages and rendered nowhere, now fires at the moment the user switches.
