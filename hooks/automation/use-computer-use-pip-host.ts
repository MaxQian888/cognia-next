"use client"

import { useCallback, useState, useSyncExternalStore } from "react"
import type { PictureInPictureRect } from "@/lib/automation/picture-in-picture-layout"

export interface ComputerUsePipHostGeometry {
  host: Element | null
  rect: PictureInPictureRect
  obstacles: readonly PictureInPictureRect[]
  visible: boolean
}
const EMPTY: ComputerUsePipHostGeometry = {
  host: null,
  rect: { x: 0, y: 0, width: 0, height: 0 },
  obstacles: [],
  visible: false,
}
const hosts = new Map<
  Element,
  { snapshot: ComputerUsePipHostGeometry; listeners: Set<() => void>; dispose: () => void }
>()
function rectOf(element: Element): PictureInPictureRect {
  const { x, y, width, height } = element.getBoundingClientRect()
  return { x, y, width, height }
}

export function getComputerUsePipHost(host: Element): ComputerUsePipHostGeometry {
  return hosts.get(host)?.snapshot ?? EMPTY
}

/** One observer/scheduled geometry batch per host, shared by duplicate views. */
export function subscribeComputerUsePipHost(host: Element, listener: () => void): () => void {
  let entry = hosts.get(host)
  if (!entry) {
    entry = { snapshot: EMPTY, listeners: new Set(), dispose: () => {} }
    hosts.set(host, entry)
    const owner = entry
    let scheduled: number | null = null
    let intersecting = true
    const ancestors: Element[] = []
    for (let node: Element | null = host; node; node = node.parentElement) ancestors.push(node)
    const observed = new Set<Element>()
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule)
    const attributes =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule)
    function update() {
      const rect = rectOf(host)
      const obstacles = [...host.querySelectorAll("[data-computer-use-pip-obstacle]")]
      for (const previous of observed)
        if (!obstacles.includes(previous)) {
          resize?.unobserve(previous)
          observed.delete(previous)
        }
      for (const obstacle of obstacles)
        if (!observed.has(obstacle)) {
          resize?.observe(obstacle)
          observed.add(obstacle)
        }
      attributes?.disconnect()
      for (const element of [...ancestors, ...obstacles])
        attributes?.observe(element, {
          attributes: true,
          attributeFilter: ["class", "style", "hidden"],
        })
      const visible =
        intersecting &&
        document.visibilityState !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x < window.innerWidth &&
        rect.y < window.innerHeight &&
        rect.x + rect.width > 0 &&
        rect.y + rect.height > 0 &&
        ancestors.every((element) => {
          const style = getComputedStyle(element)
          return style.display !== "none" && style.visibility !== "hidden"
        })
      const next = { host, rect, obstacles: obstacles.map(rectOf), visible }
      const previous = owner.snapshot
      if (
        previous.visible === visible &&
        JSON.stringify(previous.rect) === JSON.stringify(rect) &&
        JSON.stringify(previous.obstacles) === JSON.stringify(next.obstacles)
      )
        return
      owner.snapshot = next
      for (const notify of owner.listeners) notify()
    }
    function schedule() {
      if (scheduled !== null) return
      scheduled = requestAnimationFrame(() => {
        scheduled = null
        update()
      })
    }
    const scroll = (event: Event) => {
      const target = event.target
      if (
        target === document ||
        target === window ||
        (target instanceof Node && (target.contains(host) || host.contains(target)))
      )
        schedule()
    }
    const visibility = () => {
      // A hidden document may suspend rAF indefinitely; release media now.
      if (document.visibilityState === "hidden") {
        if (owner.snapshot.visible) {
          owner.snapshot = { ...owner.snapshot, visible: false }
          for (const notify of owner.listeners) notify()
        }
      } else schedule()
    }
    const children =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((mutations) => {
            if (
              mutations.some((mutation) =>
                [...mutation.addedNodes, ...mutation.removedNodes].some(
                  (node) =>
                    node instanceof Element &&
                    (node.matches("[data-computer-use-pip-obstacle]") ||
                      node.querySelector("[data-computer-use-pip-obstacle]"))
                )
              )
            )
              schedule()
          })
    const intersection =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            const next = entries[0]?.isIntersecting ?? false
            if (intersecting !== next) {
              intersecting = next
              schedule()
            }
          })
    resize?.observe(host)
    intersection?.observe(host)
    children?.observe(host, { childList: true, subtree: true })
    document.addEventListener("scroll", scroll, true)
    document.addEventListener("visibilitychange", visibility)
    window.addEventListener("resize", schedule)
    update()
    owner.dispose = () => {
      if (scheduled !== null) cancelAnimationFrame(scheduled)
      resize?.disconnect()
      attributes?.disconnect()
      children?.disconnect()
      intersection?.disconnect()
      document.removeEventListener("scroll", scroll, true)
      document.removeEventListener("visibilitychange", visibility)
      window.removeEventListener("resize", schedule)
    }
  }
  entry.listeners.add(listener)
  const owner = entry
  return () => {
    owner.listeners.delete(listener)
    if (!owner.listeners.size) {
      owner.dispose()
      hosts.delete(host)
    }
  }
}

export function useComputerUsePipHost(enabled = true) {
  const [host, setHost] = useState<Element | null>(null)
  const ref = useCallback((element: HTMLDivElement | null) => {
    setHost(element?.parentElement?.closest("[data-computer-use-pip-host]") ?? null)
  }, [])
  const geometry = useSyncExternalStore(
    useCallback(
      (listener) => (host && enabled ? subscribeComputerUsePipHost(host, listener) : () => {}),
      [host, enabled]
    ),
    () => (host && enabled ? getComputerUsePipHost(host) : EMPTY),
    () => EMPTY
  )
  return { ref, geometry, hasHost: host !== null }
}
