---
"cognia-next": patch
---

Fix the title-bar workspace chip opening the command palette instead of a project switcher: the "Default"-style indicator now mounts the real `WorkspaceSwitcher` (wide variant — initial, name, chevron), so clicking it opens the workspace picker popover anchored under the chip. The segment also stands down while the conversation sidebar's header — which carries the same switcher — is projected into the bar's start zone, so `/` no longer shows two identical chips. Search still opens the command palette.
