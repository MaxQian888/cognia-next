"use client"

// Center-pane container for the Library section. Composes a two-column
// layout: the capability rail (PluginCategorySidebar) on the left for
// `lg:` and wider viewports, the filtered list (PluginLibraryList) on the
// right. Narrow viewports collapse the rail away — the header surfaces a
// PluginCategorySheet trigger so capability filtering stays reachable.
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
    <div className="flex h-full min-h-0" data-testid="plugin-library-pane">
      <aside
        className="hidden lg:block w-44 xl:w-52 shrink-0 overflow-y-auto border-r p-2"
        aria-label={t("categoriesButton")}
        data-testid="plugin-library-capability-rail"
      >
        <PluginCategorySidebar />
      </aside>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <PluginLibraryList />
      </div>
    </div>
  )
}
