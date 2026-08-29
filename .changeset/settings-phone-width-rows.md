---
"cognia-next": patch
---

Settings layout: two rows that overflowed their own border on a phone.

- **Terminal → autocomplete** put "File paths", "Command names" and "CLI flags" beside a switch in a three-column grid. A third of a phone-width settings pane leaves the label about 50px, and neither the label nor the switch shrinks below its longest word, so each cell spilled past its border. The three now stack below `sm`.
- **Search → usage** shows the most-used provider's name — the one stat that is a name rather than a number — in a third of that same width. "Google Custom Search" now wraps inside its box instead of widening the whole row.

A new guard fails any settings file that pairs a label with a control inside a 3-up grid that has no single-column base.
