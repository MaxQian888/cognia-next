---
"cognia-next": minor
---

Python plugins can read the app's language and translate their own surfaces.

`ctx.i18n` was reachable from TypeScript plugins only, so anything a Python plugin painted was English whatever language the app was in. It is now open to Python, minus its two subscription methods — `onLocaleChange` and `registerTranslations` hand the host a callback, which the contract already marked and the runtime already refuses by name.

RepoWiki uses it: the wiki is written in the app's language unless its `language` setting names one (a Chinese reader may still want an English wiki for an English-speaking team), and the reader panel's own labels are translated from the plugin's manifest bundle, falling back per key rather than wholesale.
