function numberOf(value: string) {
  return parseFloat(value) || 0
}

function intrinsicTitleWidth(element: HTMLElement) {
  const style = getComputedStyle(element)
  const children = Array.from(element.children)
  return (
    children.reduce(
      (width, child) =>
        width +
        (child instanceof HTMLElement
          ? Math.max(child.scrollWidth, child.offsetWidth)
          : child.getBoundingClientRect().width),
      0
    ) +
    Math.max(0, children.length - 1) * numberOf(style.columnGap)
  )
}

/**
 * A tab strip may be clipped and scrolled; its allocated width is not its
 * minimum. Reserve one complete active tab plus the visible header actions.
 * Other open tabs stay horizontally scrollable instead of widening the dock.
 */
export function measureWorkbenchHeaderMinimumWidth(header: HTMLElement): number {
  if (header.offsetWidth <= 0) return 0
  const style = getComputedStyle(header)
  const children = Array.from(header.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && getComputedStyle(child).display !== "none"
  )
  const contentWidth = children.reduce((total, child) => {
    const childStyle = getComputedStyle(child)
    const activeTab = child.querySelector<HTMLElement>("[data-workbench-active-tab]")
    const width = child.hasAttribute("data-workbench-spacer")
      ? 0
      : activeTab
        ? Math.max(activeTab.scrollWidth, activeTab.offsetWidth)
        : child.hasAttribute("data-workbench-title")
          ? intrinsicTitleWidth(child)
          : child.offsetWidth
    return total + width + numberOf(childStyle.marginLeft) + numberOf(childStyle.marginRight)
  }, 0)
  return Math.ceil(
    contentWidth +
      Math.max(0, children.length - 1) * numberOf(style.columnGap) +
      numberOf(style.paddingLeft) +
      numberOf(style.paddingRight) +
      numberOf(style.borderLeftWidth) +
      numberOf(style.borderRightWidth)
  )
}
