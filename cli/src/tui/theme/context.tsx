/**
 * React context carrying the active {@link ThemePalette} to every TUI component.
 * The App resolves the palette once (via {@link resolveTheme}) and wraps the
 * tree in {@link ThemeProvider}; components read tokens with {@link useTheme}
 * instead of hardcoding ANSI colour names. The default (no provider) is the
 * `classic` palette, so a component rendered in isolation (e.g. a unit test)
 * keeps the historic colours.
 */
import React, { createContext, useContext } from "react"

import { getBuiltinTheme } from "./builtins"
import type { ThemePalette } from "./palette"

const ThemeContext = createContext<ThemePalette>(getBuiltinTheme("classic"))

export interface ThemeProviderProps {
  palette: ThemePalette
  children: React.ReactNode
}

export function ThemeProvider({ palette, children }: ThemeProviderProps): React.ReactElement {
  return <ThemeContext.Provider value={palette}>{children}</ThemeContext.Provider>
}

/** Read the active palette. Returns the `classic` palette outside a provider. */
export function useTheme(): ThemePalette {
  return useContext(ThemeContext)
}
