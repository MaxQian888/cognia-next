---
"cognia-next": patch
---

The DevTools "Hot-reload activity" panel now shows what actually happened. It reads a session store that no production code ever wrote to, so on `/plugins → Devtools` it rendered its empty state forever, no matter how many plugins you installed or reloaded. Its tests passed because they seeded the store directly. Three real writers are now wired up: the CLI bridge records installs and uninstalls, and the verified `plugin_dev_reload` round-trip records the attempt and then settles it in place with the outcome, including the failure message. An install event is still never allowed to claim a runtime success, which was the original reason nothing was recorded at all. Rows also say which driver did the work, so a drag-and-drop "Load unpacked" install is no longer credited to the CLI, and the status is now named for screen readers instead of being carried by icon colour alone.
