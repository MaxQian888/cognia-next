---
"cognia-next": minor
---

Rework the Logs and diagnostics page so every channel links, filters and recovers properly.

- **Logs**: search now covers agent trace spans, and the list is one continuous keyboard-navigable list instead of pages. The dashboard cards filter when clicked. The native log viewer opens inline. The header and the panel share one health poll and agree on the count.
- **Traces**: links survive reloads and in-app navigation, using their own `t`-prefixed URL keys. Dashboard charts drill into matching traces. Hidden panels keep their layout. The list holds still while you read it.
- **Crash reports**: previews always belong to the report on screen, and each report is linkable. Mobile submission works. Destructive actions ask first. The opt-in automatic submission now sends reports and shows each receipt.
- **Service console**: it only fetches while open, learns your access role, and saves downloaded artifacts.
- **Names**: the channels are renamed Errors and Crash reports to say what they hold.
