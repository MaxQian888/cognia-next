"use client"

// Center-pane container for the Library section. Composes a two-column
// layout: the capability rail (PluginCategorySidebar) on the left when the
// *pane* is wide enough, the filtered list (PluginLibraryList) on the
// right. Narrow panes collapse the rail away and this pane surfaces a
// PluginCategorySheet trigger in its place, gated on the SAME container
// query, so capability filtering stays reachable at every width.
//
// Breakpoints are container-relative (`@container/plugin-pane`), NOT
// viewport-relative: this pane only occupies a fraction of the window, so
// a `lg:` viewport rule would wrongly render the rail (and a multi-column
// grid) inside a cramped column on a wide screen and overlap the content.
//
// The rail and the library list both write to / read from the same store
// filters (`filters.capability` + `librarySubFilter`), so the two axes
// compose as AND.

import { useTranslations } from "next-intl"
import { PluginCategorySheet } from "../dialogs/plugin-category-sheet"
import { PluginCategorySidebar } from "../plugin-category-sidebar"
import { PluginLibraryList } from "./plugin-library-list"

export function PluginLibraryPane() {
  const t = useTranslations("plugins.panel")
  return (
    <div className="@container/plugin-pane flex h-full min-h-0" data-testid="plugin-library-pane">
      <aside
        className="hidden @xl/plugin-pane:block w-40 @4xl/plugin-pane:w-52 shrink-0 overflow-y-auto border-r p-2"
        aria-label={t("categoriesButton")}
        data-testid="plugin-library-capability-rail"
      >
        <PluginCategorySidebar />
      </aside>
      {/* Nested container so the list body (cards / rows) measures the space
          it actually gets — i.e. after the rail is subtracted. */}
      <div className="@container/plugin-list flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* The rail's fallback lives HERE, not in the page header, and is
            gated on the SAME container as the rail itself. It used to sit in
            `PluginLibraryHeader` behind `lg:hidden` — a *viewport* rule
            against a *container*-gated rail. Between a >=1024px viewport and
            a <768px center pane both were hidden at once, which is the
            default split on an ordinary desktop, so the capability axis had
            no discoverable entry point at all. One container, one gate, no
            gap. */}
        <div className="@xl/plugin-pane:hidden shrink-0 border-b px-2 py-1.5">
          <PluginCategorySheet />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PluginLibraryList />
        </div>
      </div>
    </div>
  )
}
