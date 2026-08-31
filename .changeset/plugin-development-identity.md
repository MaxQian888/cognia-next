---
"cognia-next": minor
---

A development build of a plugin now looks like one. The plugin detail header rendered `plugin.source` as its raw enum, so it read "dev" or "marketplace" in English regardless of locale, and the library list showed no origin at all: a dev build sat among released ones with nothing to distinguish it, which is how an author ends up debugging a copy they are not running. Every origin now has a label in both locales, development builds are badged in the list, and a build that is standing in front of an installed one says which one it replaces. DevTools also stops telling you to restart the app and offers the restart: a plugin whose runtime is left dirty can only be cleared that way, and the workbench had been rendering that instruction as a sentence. Running `plugin new` from the CLI launcher now points at the next step rather than leaving you to work it out.
