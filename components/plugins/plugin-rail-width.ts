/**
 * Shared width for the two rails that sit side by side on `/plugins`: the
 * section nav (`PluginNavSidebar`, a resizable shell pane) and the Library's
 * capability rail (`PluginLibraryPane`, a plain fixed column inside the center
 * pane).
 *
 * They are laid out by two different mechanisms. One is a
 * `react-resizable-panels` pane sized in percent, the other a Tailwind width
 * class, so nothing kept them in agreement and they only lined up at one
 * window width. One constant, expressed in the unit both mechanisms accept,
 * makes them equal at every size.
 */
export const PLUGIN_RAIL_WIDTH = "13rem"

/** Tailwind arbitrary-value class for the same width. */
export const PLUGIN_RAIL_WIDTH_CLASS = "w-[13rem]"
