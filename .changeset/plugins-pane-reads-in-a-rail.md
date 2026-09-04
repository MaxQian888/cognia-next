---
"cognia-next": patch
---

The plugins page reads in the width it actually gets. The rail is pinned to a fixed width instead of taking a third of the window, and the detail pane drops its nested cards for flat labelled groups with a hairline: a card inside a collapsible section inside a scroll area was spending most of a narrow pane on borders, radii and padding, and reading as depth that was not there. Library rows, the detail header and the overview are laid out for that width too, and the activation progress indicator no longer prints its detail line when there is no room for it.
