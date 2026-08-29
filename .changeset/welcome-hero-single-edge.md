---
"cognia-next": patch
---

Rebuild the welcome screen's hero so the composer is unambiguously what starts a chat. The screen carried two ways to begin: a filled "New chat" button in the hero, and the live composer below it — which, with no session open, creates one on its first send anyway. The redundant control was the louder of the two and discarded whatever had been typed. It is now a quiet ghost action under the composer, alongside the execution picker (which sits beside the box that will actually run the turn), and only surfaces that render no composer at all — the workflow-editor chat tab — keep it as the hero's primary action.

The hero's two-column grid is gone with it. The copy used to sit in the grid's first track and stop around 60% of the reading column, while the composer beneath spanned the full width, so two stacked elements met at different left edges. The workspace artwork is now positioned out of flow behind the copy — faded, masked, and bleeding past the column to be clipped at the pane edge — leaving one column, one edge, and one focus block from the greeting through to the box. Narrow panes drop the artwork instead of reflowing the text.
