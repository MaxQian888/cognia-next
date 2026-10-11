"use client"

// Center-pane container for the Library section: the filter/result strip on
// top, the list (rows or cards) below.
//
// The capability facets are NOT here any more. On a desktop-width window they
// live in the section nav rail under Library (`plugin-nav-sidebar.tsx`), which
// is always on screen beside this pane. They used to be a second fixed 13rem
// rail inside this pane, so the window spent two rails of chrome before the
// list began and the list itself was squeezed below the width its rows needed.
//
// Where the nav rail is NOT on screen (the tablet overlay, where it sits in a
// sheet, and the phone body, which has no rail), the facets stay one tap away
// through the "Categories" trigger in the list's head bar
// (`plugin-library-list.tsx`). Its gate is the same breakpoint
// `FeaturePageShell` uses to decide between inline rails and sheets, so
// exactly one entry point exists at every width.
//
// The facets and the library list both write to / read from the same store
// filters (`filters.capability` + the status sub-filter), so the two axes
// compose as AND.

import { PluginLibraryList } from "./plugin-library-list"
import { PluginLibraryStatusBar } from "./plugin-library-status-bar"

export function PluginLibraryPane() {
  return (
    <div
      className="@container/plugin-list flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="plugin-library-pane"
    >
      {/* Filter chips + result count — first in the list column, never the
          page header. Why: `plugin-library-status-bar.tsx`. */}
      <PluginLibraryStatusBar />
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="plugin-library-list-column">
        <PluginLibraryList />
      </div>
    </div>
  )
}
