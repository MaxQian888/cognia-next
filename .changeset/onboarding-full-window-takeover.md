---
"cognia-next": minor
---

First-run setup is now a full-window takeover instead of a page rendered inside the workspace frame. `/onboarding` suppresses the desktop chrome — title bar, guild rail, status bar, terminal dock and the residual finish-setup notice — and the flow draws its own transparent window bar carrying Back, the wordmark, the drag region, and the minimise/maximise/close buttons on Windows and Linux (macOS keeps its native traffic lights, and the bar reserves room for them). Setup no longer advertises a workspace the user has not finished setting up.

The layout inside is rebuilt to one geometry: the step rail is a flush full-height column with a hairline edge and a connected stepper instead of a floating `rounded-2xl` card in a padded gutter, and it follows the app theme rather than forcing a dark slab under a light one. Every framed block in the flow — sign-in cards, starter cards, scan and migration rows, the API-key panel — now shares the design system's `rounded-xl`, so the window edges are square and the radii belong to the content. Back exists once, at every width, instead of once in the rail and once in the narrow progress bar.

The sign-in step is two-stage: pick a method, and the API-key form replaces the chooser only when that is the method you picked (with a way back). It used to sit open below the cards, putting two buttons labelled "Continue" on the same screen — the flow's action row now stands down while the key panel owns the primary action.
