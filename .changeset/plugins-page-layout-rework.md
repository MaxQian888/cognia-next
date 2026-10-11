---
"cognia-next": minor
---

Rework the plugin manager and plugin detail on desktop and mobile: the detail is now a tabbed pane (Overview, Capabilities, Configure, Permissions, Data) that opens only when a plugin is selected and closes with a button or Escape; the capability filter moves into the single left rail with every capability named; the list gains keyboard navigation, a "Clear filters" action and, on phones, a selection mode; card-in-card nesting across the detail, Governance and Discover is flattened; and several gaps are fixed (batch actions on hidden selections, the Enabled/Errored filters reading the wrong field, "Delete data" uninstalling the plugin, ungated Rollback, missing per-plugin Update, untranslated names, sources, dates and capability ids). A configuration variant choice is now saved under a language-independent id, so it no longer resets after switching the UI language; choices saved under a translated title still resolve and are migrated on the next save.
