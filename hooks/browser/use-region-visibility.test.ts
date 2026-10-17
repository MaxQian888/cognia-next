/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useRegionVisibility } from "./use-region-visibility"

// jsdom has no IntersectionObserver — stub one that exposes its callback.
let ioCallback: ((entries: unknown[]) => void) | null = null
const ioObserve = jest.fn()
const ioDisconnect = jest.fn()

class MockIO {
  constructor(cb: (entries: unknown[]) => void) {
    ioCallback = cb
  }
  observe = ioObserve
  disconnect = ioDisconnect
  unobserve = jest.fn()
  takeRecords = jest.fn()
}

beforeEach(() => {
  ioCallback = null
  ioObserve.mockClear()
  ioDisconnect.mockClear()
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO
  document.body.innerHTML = ""
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
})

/** Attach an element under `document.body` and return a stable ref to it. */
function mountRegion() {
  const wrap = document.createElement("div")
  const el = document.createElement("div")
  el.getBoundingClientRect = () => new DOMRect(100, 100, 400, 300)
  wrap.appendChild(el)
  document.body.appendChild(wrap)
  const ref = { current: el } as React.RefObject<HTMLElement>
  const view = renderHook(() => useRegionVisibility(ref))
  return { ...view, el, wrap }
}

function mountPortalElement(slot: string, rect: DOMRect) {
  const portal = document.createElement("div")
  portal.dataset.radixPortal = ""
  const content = document.createElement("div")
  content.dataset.slot = slot
  content.getBoundingClientRect = () => rect
  portal.appendChild(content)
  document.body.appendChild(portal)
  return portal
}

it("is visible by default", () => {
  const { result } = mountRegion()
  expect(result.current).toBe(true)
  expect(ioObserve).toHaveBeenCalled()
})

it("hides for a Next.js error overlay in a persistent shadow portal and restores on close", async () => {
  const { result } = mountRegion()
  const portal = document.createElement("nextjs-portal")
  const shadow = portal.attachShadow({ mode: "open" })
  const badge = document.createElement("button")
  badge.setAttribute("data-nextjs-toast", "")
  shadow.appendChild(badge)

  await act(async () => {
    document.body.appendChild(portal)
  })
  expect(result.current).toBe(true)

  const overlay = document.createElement("div")
  overlay.setAttribute("data-nextjs-dialog-overlay", "")
  overlay.setAttribute("data-rendered", "true")
  // Next.js retains the dialog inside the overlay during its close animation.
  overlay.innerHTML = '<div data-nextjs-dialog aria-modal="true" role="dialog"></div>'
  await act(async () => {
    shadow.appendChild(overlay)
  })
  expect(result.current).toBe(false)

  await act(async () => {
    overlay.setAttribute("data-rendered", "false")
  })
  expect(result.current).toBe(true)

  await act(async () => {
    overlay.setAttribute("data-rendered", "true")
  })
  expect(result.current).toBe(false)

  await act(async () => {
    overlay.remove()
  })
  expect(result.current).toBe(true)
})

it("detects an already-open Next.js overlay and restores when its portal wrapper is removed", async () => {
  const wrapper = document.createElement("div")
  const portal = document.createElement("nextjs-portal")
  portal.attachShadow({ mode: "open" }).innerHTML = "<div data-nextjs-dialog-overlay></div>"
  wrapper.appendChild(portal)
  document.body.appendChild(wrapper)
  const { result } = mountRegion()
  expect(result.current).toBe(false)

  await act(async () => {
    wrapper.remove()
  })
  expect(result.current).toBe(true)
})

it("keeps the region hidden until both the Next.js overlay and an app dialog close", async () => {
  const { result } = mountRegion()
  const portal = document.createElement("nextjs-portal")
  const shadow = portal.attachShadow({ mode: "open" })
  let dialog: HTMLElement | null = null
  await act(async () => {
    shadow.innerHTML = "<div data-nextjs-dialog-overlay></div>"
    document.body.appendChild(portal)
    dialog = mountPortalElement("dialog-overlay", new DOMRect(0, 0, 1200, 800))
  })
  expect(result.current).toBe(false)

  await act(async () => {
    shadow.replaceChildren()
  })
  expect(result.current).toBe(false)

  await act(async () => {
    dialog?.remove()
  })
  expect(result.current).toBe(true)
})

it.each(['role="dialog"', 'role="alertdialog" aria-modal="false"', 'data-sonner-toast=""'])(
  "hides for an overlapping custom popup (%s) and restores on removal",
  async (attributes) => {
    const { result } = mountRegion()
    const container = document.createElement("div")
    container.innerHTML = `<div ${attributes}></div>`
    const popup = container.firstElementChild as HTMLElement
    popup.getBoundingClientRect = () => new DOMRect(120, 120, 160, 80)
    await act(async () => {
      document.body.appendChild(container)
    })
    expect(result.current).toBe(false)

    await act(async () => {
      container.remove()
    })
    expect(result.current).toBe(true)
  }
)

it.each(['role="dialog"', 'role="alertdialog" aria-modal="false"', 'data-sonner-toast=""'])(
  "keeps the region visible when a custom popup (%s) does not overlap it",
  async (attributes) => {
    const { result } = mountRegion()
    const container = document.createElement("div")
    container.innerHTML = `<div ${attributes}></div>`
    const popup = container.firstElementChild as HTMLElement
    popup.getBoundingClientRect = () => new DOMRect(0, 0, 80, 40)
    await act(async () => {
      document.body.appendChild(container)
    })
    expect(result.current).toBe(true)
  }
)

it("disconnects the Next.js shadow observer on portal removal and unmount", async () => {
  const disconnect = jest.spyOn(MutationObserver.prototype, "disconnect")
  const { unmount } = mountRegion()
  const portal = document.createElement("nextjs-portal")
  portal.attachShadow({ mode: "open" })
  await act(async () => {
    document.body.appendChild(portal)
  })
  await act(async () => {
    portal.remove()
  })
  expect(disconnect).toHaveBeenCalledTimes(1)
  await act(async () => {
    document.body.appendChild(portal)
  })
  unmount()
  expect(disconnect).toHaveBeenCalledTimes(3)
  disconnect.mockRestore()
})

it("restores when a toast is dismissed but remains mounted for its exit animation", async () => {
  const { result } = mountRegion()
  const toast = document.createElement("div")
  toast.setAttribute("data-sonner-toast", "")
  toast.getBoundingClientRect = () => new DOMRect(120, 120, 160, 80)
  await act(async () => {
    document.body.appendChild(toast)
  })
  expect(result.current).toBe(false)

  await act(async () => {
    toast.setAttribute("data-removed", "true")
  })
  expect(result.current).toBe(true)
})

it("keeps an editor inside its own dialog visible", async () => {
  const { result, wrap } = mountRegion()
  await act(async () => {
    wrap.setAttribute("role", "dialog")
    wrap.setAttribute("aria-modal", "true")
  })
  expect(result.current).toBe(true)
})

it("ignores a CSS-hidden modal and responds when its wrapper becomes visible", async () => {
  const { result } = mountRegion()
  const wrapper = document.createElement("div")
  wrapper.style.display = "none"
  wrapper.innerHTML = '<div role="dialog" aria-modal="true"></div>'
  await act(async () => {
    document.body.appendChild(wrapper)
  })
  expect(result.current).toBe(true)

  await act(async () => {
    wrapper.style.display = "block"
  })
  expect(result.current).toBe(false)

  await act(async () => {
    wrapper.hidden = true
  })
  expect(result.current).toBe(true)
})

it("hides when a modal marks an ancestor aria-hidden, and restores on close", async () => {
  const { result, wrap } = mountRegion()
  expect(result.current).toBe(true)

  await act(async () => {
    wrap.setAttribute("aria-hidden", "true")
  })
  expect(result.current).toBe(false)

  await act(async () => {
    wrap.removeAttribute("aria-hidden")
  })
  expect(result.current).toBe(true)
})

it("hides when an ancestor becomes inert", async () => {
  const { result, wrap } = mountRegion()
  await act(async () => {
    wrap.setAttribute("inert", "")
  })
  expect(result.current).toBe(false)
})

it.each(["dialog-overlay", "alert-dialog-overlay", "sheet-overlay", "drawer-overlay"])(
  "hides while a modal %s is mounted, even without aria-hidden on the region",
  async (slot) => {
    const { result } = mountRegion()
    let portal: HTMLElement | null = null

    await act(async () => {
      portal = mountPortalElement(slot, new DOMRect(0, 0, 1200, 800))
    })
    expect(result.current).toBe(false)

    await act(async () => {
      portal?.remove()
    })
    expect(result.current).toBe(true)
  }
)

it.each(["tooltip-content", "select-content"] as const)(
  "hides while an intersecting %s portal is open, and restores when it closes",
  async (slot) => {
    const { result } = mountRegion()
    let portal: HTMLElement | null = null

    await act(async () => {
      portal = mountPortalElement(slot, new DOMRect(120, 120, 160, 80))
    })
    expect(result.current).toBe(false)

    await act(async () => {
      portal?.remove()
    })
    expect(result.current).toBe(true)
  }
)

it("restores visibility when a mounted overlay transitions to the closed state", async () => {
  const { result } = mountRegion()
  let overlay: HTMLElement | null = null

  await act(async () => {
    const portal = mountPortalElement("dialog-overlay", new DOMRect(0, 0, 1200, 800))
    overlay = portal.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')
    overlay?.setAttribute("data-state", "open")
  })
  expect(result.current).toBe(false)

  await act(async () => {
    overlay?.setAttribute("data-state", "closed")
  })
  expect(result.current).toBe(true)
})

it("hides for a native dialog and restores when its open attribute is removed", async () => {
  const { result } = mountRegion()
  const dialog = document.createElement("dialog")

  await act(async () => {
    dialog.setAttribute("open", "")
    document.body.appendChild(dialog)
  })
  expect(result.current).toBe(false)

  await act(async () => {
    dialog.removeAttribute("open")
  })
  expect(result.current).toBe(true)
})

it("hides for a custom aria-modal dialog and restores when it closes", async () => {
  const { result } = mountRegion()
  const dialog = document.createElement("div")
  dialog.setAttribute("role", "dialog")

  await act(async () => {
    dialog.setAttribute("aria-modal", "true")
    document.body.appendChild(dialog)
  })
  expect(result.current).toBe(false)

  await act(async () => {
    dialog.setAttribute("aria-modal", "false")
  })
  expect(result.current).toBe(true)
})

it("stays visible when a floating overlay does not cover the region", async () => {
  const { result } = mountRegion()

  await act(async () => {
    mountPortalElement("tooltip-content", new DOMRect(0, 0, 80, 40))
  })

  expect(result.current).toBe(true)
})

it.each([
  "combobox-content",
  "context-menu-content",
  "dropdown-menu-content",
  "hover-card-content",
  "menubar-content",
  "navigation-menu-content",
  "popover-content",
])("hides while an intersecting %s portal is open", async (slot) => {
  const { result } = mountRegion()

  await act(async () => {
    mountPortalElement(slot, new DOMRect(120, 120, 160, 80))
  })

  expect(result.current).toBe(false)
})

it("hides when the window is backgrounded", () => {
  const { result } = mountRegion()
  act(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  expect(result.current).toBe(false)
})

it("hides when the region scrolls off screen", () => {
  const { result } = mountRegion()
  act(() => ioCallback?.([{ isIntersecting: false, intersectionRatio: 0 }]))
  expect(result.current).toBe(false)
  act(() => ioCallback?.([{ isIntersecting: true, intersectionRatio: 1 }]))
  expect(result.current).toBe(true)
})

it("disconnects its observers on unmount", () => {
  const { unmount } = mountRegion()
  unmount()
  expect(ioDisconnect).toHaveBeenCalled()
})

it("stays visible and observes nothing when the ref is empty", () => {
  const ref = { current: null } as React.RefObject<HTMLElement | null>
  const { result } = renderHook(() => useRegionVisibility(ref))
  expect(result.current).toBe(true)
  expect(ioObserve).not.toHaveBeenCalled()
})

it("falls back to occlusion/visibility signals when IntersectionObserver is absent", async () => {
  ;(globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = undefined
  const { result, wrap } = mountRegion()
  // No IntersectionObserver → treated as on-screen, but modal occlusion still hides it.
  expect(result.current).toBe(true)
  await act(async () => {
    wrap.setAttribute("aria-hidden", "true")
  })
  expect(result.current).toBe(false)
})

it("ignores an empty IntersectionObserver batch", () => {
  const { result } = mountRegion()
  act(() => ioCallback?.([]))
  expect(result.current).toBe(true)
})
