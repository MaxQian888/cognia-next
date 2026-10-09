// The project editor's two chrome rows, shared by the editor column and the
// sidebar beside it. Both columns draw a rule under each row; sized from their
// content (a tab's padding, a toolbar's icon buttons, the workbench header's
// own `h-10`) they landed a few pixels apart and the rules stepped at the
// divider. Fixed heights from one place keep them on one line.
//
// Desktop (compact) density only: the touch layout shows one column at a time.

/** The top row: the editor's tab strip and the sidebar's header. */
export const EDITOR_TITLE_ROW_CLASS = "h-9"

/**
 * The row under it: the editor's breadcrumbs and the sidebar view's toolbar
 * (the explorer's actions, the search box).
 */
export const EDITOR_SUBTITLE_ROW_CLASS = "h-8"
