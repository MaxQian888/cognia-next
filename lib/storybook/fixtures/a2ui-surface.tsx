"use client"

// Storybook fixture for A2UI *container* renderers.
//
// Many A2UI renderers don't consume child UI through the `renderChild` envelope
// prop — they read it from React context provided by `A2UIProvider`, which is in
// turn backed by the Zustand `useA2UIStore`. Card/Column/Row/Accordion/Tabs/List
// call `<A2UIChildRenderer>` (context `renderChild` → `renderComponent(child)`),
// and Collapsible/Drawer/Sheet/Tooltip/Dialog/Chart/Pagination call `useA2UIData`
// (which throws outside a provider). This decorator seeds a real surface in the
// store and wraps the story in a real `A2UIProvider` so those components render
// their true production path — no context mocking.
import * as React from "react"
import type { Decorator } from "@storybook/nextjs"

import { A2UIProvider } from "@/components/a2ui/a2ui-context"
import { useA2UIStore } from "@/stores/a2ui"
import type { A2UIComponent } from "@/types/a2ui/schema"

/** Surface id used by every A2UI story (matches `makeA2UIProps` defaults). */
export const STORY_SURFACE_ID = "story-surface"

/**
 * Visible placeholder used for container children. Mirrors the box suggested by
 * the story-authoring guide so containers always have something to show.
 */
export function placeholderChild(id: string, label?: string): React.ReactNode {
  return (
    <div className="rounded-md border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
      {label ?? `child: ${id}`}
    </div>
  )
}

/**
 * Build a minimal, type-valid child descriptor to seed into the store. The
 * provider's `renderComponent` only needs the `id` to draw a placeholder, so a
 * lightweight `Text` node is enough.
 */
export function childStub(id: string, label?: string): A2UIComponent {
  return { id, component: "Text", text: label ?? id }
}

export interface A2UISurfaceOptions {
  /** Child component descriptors to register so context `renderChild` resolves. */
  children?: A2UIComponent[]
  /** Data-model seed for path-bound resolvers (`{ path }`). */
  dataModel?: Record<string, unknown>
}

/**
 * Decorator that provides a live `A2UIProvider` (store-backed) around a story.
 * Pass the child descriptors a container references so they render as visible
 * placeholders; pass `dataModel` when a story binds values via `{ path }`.
 */
export function withA2UISurface(options: A2UISurfaceOptions = {}): Decorator {
  const A2UISurfaceDecorator: Decorator = (Story) => {
    // Seed the store exactly once per story mount, before the provider reads it.
    React.useState(() => {
      const store = useA2UIStore.getState()
      store.createSurface(STORY_SURFACE_ID, "inline")
      if (options.children && options.children.length > 0) {
        store.updateComponents(STORY_SURFACE_ID, options.children)
      }
      if (options.dataModel) {
        store.updateDataModel(STORY_SURFACE_ID, options.dataModel, false)
      }
      return null
    })

    return (
      <A2UIProvider
        surfaceId={STORY_SURFACE_ID}
        renderComponent={(component) => placeholderChild(component.id)}
      >
        <Story />
      </A2UIProvider>
    )
  }

  return A2UISurfaceDecorator
}
