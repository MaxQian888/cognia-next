"use client"

// Center-pane container for the Library section. Composes a two-column
// layout: the capability rail (PluginCategorySidebar) on the left when the
// *pane* is wide enough, the filtered list (PluginLibraryList) on the
// right. Narrow panes collapse the rail away — the header surfaces a
// PluginCategorySheet trigger so capability filtering stays reachable.
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
import { PluginCategorySidebar } from "../plugin-category-sidebar"
import { PluginLibraryList } from "./plugin-library-list"

export function PluginLibraryPane() {
  const t = useTranslations("plugins.panel")
  return (
    <div className="@container/plugin-pane flex h-full min-h-0" data-testid="plugin-library-pane">
      <aside
        className="hidden @3xl/plugin-pane:block w-44 @5xl/plugin-pane:w-52 shrink-0 overflow-y-auto border-r p-2"
        aria-label={t("categoriesButton")}
        data-testid="plugin-library-capability-rail"
      >
        <PluginCategorySidebar />
      </aside>
      {/* Nested container so the list body (cards / rows) measures the space
          it actually gets — i.e. after the rail is subtracted. */}
      <div className="@container/plugin-list flex-1 min-h-0 overflow-y-auto">
        <PluginLibraryList />
      </div>
    </div>
  )
}
