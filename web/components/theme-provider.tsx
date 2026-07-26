"use client"

import { ThemeProvider as NextThemeProvider } from "next-themes"
import type { ReactNode } from "react"

/**
 * Theme wiring (ADR-0092 §10).
 *
 * `attribute="class"` is what `@custom-variant dark (&:is(.dark *))` in
 * `globals.css` keys off. `disableTransitionOnChange` stops every transitioned
 * property on the page from animating at once when the mode flips, which reads
 * as a flash rather than as a transition.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  )
}
