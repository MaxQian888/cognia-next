import * as React from "react"
import {
  AppRouterContext,
  GlobalLayoutRouterContext,
  LayoutRouterContext as NextLayoutRouterContext,
  MissingSlotContext,
  TemplateContext,
} from "next/dist/shared/lib/app-router-context.shared-runtime.js"

// Stand-in for `next/dist/shared/lib/app-router-context.shared-runtime.js`,
// substituted ONLY for imports issued from `@storybook/nextjs/dist` (see the
// `beforeResolve` hook in main.ts). Every other importer — `next/navigation`,
// app code — still gets Next's real module, and the contexts re-exported here
// ARE Next's, so both sides share one context instance.
//
// Why: Next 16.4's `useRouter()` reads
// `useContext(LayoutRouterContext)?.parentRenderTree.data.bfcacheId`.
// `@storybook/nextjs` 10.6.x mocks the App Router with a LayoutRouterContext
// value shaped for Next 15 (`parentTree` / `parentCacheNode`, no
// `parentRenderTree`). The value is non-null, so the optional chain stops
// short, `.data` is read off `undefined`, and the framework's own
// `RedirectBoundary` (which calls `useRouter()` around every story) throws
// "Cannot read properties of undefined (reading 'data')" — every story fails.
//
// The framework only ever renders `LayoutRouterContext.Provider`, so that is
// the one member replaced. The Provider fills in a minimal `parentRenderTree`
// (bfcacheId 0, the value Next itself uses for a root that never navigated)
// and passes a value that already has one through untouched, so this becomes a
// no-op once the framework catches up. Drop it, and the hook in main.ts, then.

export { AppRouterContext, GlobalLayoutRouterContext, MissingSlotContext, TemplateContext }

type LayoutRouterValue = NonNullable<React.ContextType<typeof NextLayoutRouterContext>>
type RenderTree = LayoutRouterValue["parentRenderTree"]

/** Value shape `@storybook/nextjs` 10.6 actually passes (Next 15 era). */
type StorybookLayoutRouterValue = Omit<LayoutRouterValue, "parentRenderTree"> & {
  parentRenderTree?: RenderTree
  parentCacheNode?: object
}

export function withParentRenderTree(
  value: StorybookLayoutRouterValue | null
): LayoutRouterValue | null {
  if (!value || value.parentRenderTree) return value as LayoutRouterValue | null
  const parentRenderTree = {
    segment: value.parentTree?.[0] ?? "",
    data: { ...value.parentCacheNode, bfcacheId: 0 },
    slots: null,
  } as unknown as RenderTree
  return { ...value, parentRenderTree }
}

function Provider({
  value,
  children,
}: {
  value: StorybookLayoutRouterValue | null
  children?: React.ReactNode
}) {
  return (
    <NextLayoutRouterContext.Provider value={withParentRenderTree(value)}>
      {children}
    </NextLayoutRouterContext.Provider>
  )
}

export const LayoutRouterContext = { Provider }
