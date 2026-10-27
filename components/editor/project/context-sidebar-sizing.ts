/**
 * Size against the editor's workspace, which may be much smaller than the window.
 * Keep the tree compact, while reserving enough space for its measured header.
 * The header floor may exceed the preferred cap, within the editor's budget.
 */
export const CONTEXT_SIDEBAR_MAX_PERCENT = 65

export function getContextSidebarSizing(workspaceWidth: number, headerMinimumWidth = 0) {
  const width = Number.isFinite(workspaceWidth) && workspaceWidth > 0 ? workspaceWidth : 600
  const headerWidth = Number.isFinite(headerMinimumWidth)
    ? Math.max(0, Math.ceil(headerMinimumWidth))
    : 0
  const minWidth = Math.min(
    Math.floor((width * CONTEXT_SIDEBAR_MAX_PERCENT) / 100),
    Math.max(Math.min(200, Math.round(width * 0.4)), headerWidth)
  )
  return {
    minWidth,
    defaultWidth: Math.round(Math.max(minWidth, Math.min(320, width * 0.3))),
  }
}
