---
"cognia-next": patch
---

Stop the /plugins active-filter strip from shifting the whole layout. The chips and result count used to appear inside the page header's controls band, so selecting a capability resized the header and pushed all three panes — including the rail row just clicked — out from under the cursor. They now render as a `PluginLibraryStatusBar` at the top of the library list column: the rails, detail pane, and page chrome stay put, and the strip's arrival is masked by the row set it describes. Applies to the desktop shell and the phone body, which share the same pane.
