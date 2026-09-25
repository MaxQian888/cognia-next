"use client"

/**
 * The share viewer's shell for a reader with no open account (ADR-0037, "The
 * anonymous visitor").
 *
 * `AccountGate` renders this in place of its first-run and unlock screens on
 * `/share/view`, which is how a link opened in a fresh browser on the public
 * deployment shows the share instead of "Create local account". It wraps the
 * page in the providers the viewer actually reads and nothing else:
 *
 *   - next-intl and the theme come from above the gate (`LocaleGate`,
 *     `ThemeProvider`), so they are already there.
 *   - `TooltipProvider` and `Toaster`, because the payload renderers (Markdown
 *     code blocks, A2UI components) use tooltips and toasts.
 *
 * What it leaves out is the point. No `SettingsHydrator`, no plugin runtime, no
 * Dexie: there is no account database to read, and with none selected
 * `getDb()` would open the legacy one and create it in the visitor's browser.
 * The page learns it is in this shell through {@link useShareViewerIsGuest} and
 * reads from the build-time share endpoint instead of the settings row.
 */

import { createContext, useContext, type ReactNode } from "react"

import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

const ShareGuestContext = createContext(false)

/**
 * True when the viewer is rendering inside {@link ShareGuestShell}: no account
 * is open, so there is no settings row, keyring or library to consult.
 *
 * False everywhere else, which is the in-app copy of the route under the full
 * runtime.
 */
export function useShareViewerIsGuest(): boolean {
  return useContext(ShareGuestContext)
}

export function ShareGuestShell({ children }: { children: ReactNode }) {
  return (
    <ShareGuestContext.Provider value={true}>
      <TooltipProvider>
        <div data-testid="share-guest-shell" className="contents">
          {children}
        </div>
        <Toaster />
      </TooltipProvider>
    </ShareGuestContext.Provider>
  )
}

export default ShareGuestShell
