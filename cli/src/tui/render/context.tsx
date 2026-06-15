/**
 * React context carrying the resolved transcript render preferences
 * ({@link ResolvedRenderConfig}) to every TUI component — the rendering twin of
 * {@link useTheme}. The App resolves the prefs once (via {@link resolveRenderConfig})
 * and wraps the tree in {@link RenderPrefsProvider}; components read prefs with
 * {@link useRenderPrefs} instead of threading config through props. The default
 * (no provider) is {@link RENDER_DEFAULTS}, so a component rendered in isolation
 * (e.g. a unit test) keeps the historic look.
 */
import React, { createContext, useContext } from "react"

import { RENDER_DEFAULTS, type ResolvedRenderConfig } from "../../config/schema"

const RenderPrefsContext = createContext<ResolvedRenderConfig>(RENDER_DEFAULTS)

export interface RenderPrefsProviderProps {
  prefs: ResolvedRenderConfig
  children: React.ReactNode
}

export function RenderPrefsProvider({
  prefs,
  children,
}: RenderPrefsProviderProps): React.ReactElement {
  return <RenderPrefsContext.Provider value={prefs}>{children}</RenderPrefsContext.Provider>
}

/** Read the active render preferences. Returns the defaults outside a provider. */
export function useRenderPrefs(): ResolvedRenderConfig {
  return useContext(RenderPrefsContext)
}
