/**
 * Width of the /plugins section nav rail (`PluginNavSidebar`, a resizable
 * shell pane), which also carries the Library's capability facets.
 *
 * Pinned in a CSS length, not a percentage: the rail's rows are short labels,
 * so a percentage column grows with the window for no reason. It used to be
 * shared with a second, Tailwind-sized capability rail beside it so the two
 * lined up; the facets now live inside this rail, so there is one column and
 * one width.
 */
export const PLUGIN_RAIL_WIDTH = "13rem"
