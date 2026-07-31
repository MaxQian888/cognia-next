"use client"

/**
 * Mounts the built-in A2UI action handlers (calculator / timer / todo / form /
 * unit-converter / …) once for the whole app. The A2UI event emitter is global,
 * so a single opted-in builder makes every rendered surface interactive — chat
 * messages, the Mini Apps hub and workspace/designer, and preview dialogs alike
 * — without each render site having to wire its own handler. That per-site
 * wiring was the gap that left calculator/todo buttons inert.
 *
 * Renders nothing. It re-renders when A2UI surface state changes (the builder
 * subscribes to the surfaces map), but it has no children, so it never
 * re-renders the app tree. The subscription itself is de-duplicated at module
 * scope (see `registerBuiltInActionHandler`), so mounting this once is enough.
 */

import { useA2UIAppBuilder } from "@/hooks/a2ui/use-app-builder"

export function A2UIBuiltInActionsProvider() {
  useA2UIAppBuilder({ wireBuiltInActions: true })
  return null
}
