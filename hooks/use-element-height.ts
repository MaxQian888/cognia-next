"use client"

import { useElementAxisSize } from "@/hooks/use-element-axis-size"

/**
 * Tracks the rendered height (in px) of `el`. Unlike {@link useElementWidth}
 * (which takes a `RefObject`), this accepts the element value directly so it
 * composes with state-held element references such as the composer's
 * `setContainerEl` callback ref. Measures synchronously on mount (before
 * paint) and again on every ResizeObserver tick.
 *
 * Returns `0` until an element is provided — callers should treat `0` as
 * "not yet measured" and fall back to a sane default.
 *
 * The measurement itself lives in {@link useElementAxisSize}; this is that hook
 * with the axis pinned, kept as its own name because ~every call site reads
 * better for it.
 */
export function useElementHeight(el: HTMLElement | null): number {
  return useElementAxisSize(el, "height")
}
