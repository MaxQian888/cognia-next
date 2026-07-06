// Route-level runtime gate for the two secondary desktop-pet windows.
//
// The transparent sprite overlay (`/pet-overlay`, window label "pet") and the
// click popup (`/pet-popup`, label "pet-popup") load the same root
// `app/layout.tsx` as every other window. Rendering the FULL provider tree
// there boots the entire app runtime — plugin manager + WASM preload, workflow
// runtime, twin worker, gateway, schedulers, catalog fetches, connector bus,
// companion boot, backup scheduler, … — in each pet webview. That is the
// desktop pet's lag (three full app runtimes competing for the CPU) and every
// one of those surfaces is a potential opaque paint inside what must be a
// transparent, paint-through window.
//
// This gate keys off the ROUTE (`usePathname`), not the Tauri window label:
// the static export prerenders `/pet-overlay` / `/pet-popup` with the same
// pathname the client hydrates with, so the server HTML and the first client
// render agree and there is no hydration mismatch (a label probe like
// `getPetWindowRole()` only resolves client-side and would mismatch). Mirrors
// `isShellBypassRoute` in `desktop-app-shell.tsx`, which keys off the same
// prefixes for the chrome bypass.
//
// `app/layout.tsx` passes the minimal pet provider tree via `petShell` — only
// what the pet views actually consume: next-intl messages (LocaleGate),
// settings hydration + theme/font sync, and the tooltip context. Everything
// pet-specific flows in through Dexie `useLiveQuery` and the cross-window
// bridge, neither of which needs a provider.

"use client"

import { usePathname } from "next/navigation"

/** Routes served inside the secondary desktop-pet windows. */
const PET_WINDOW_ROUTE_PREFIXES = ["/pet-overlay", "/pet-popup"] as const

/** True when the pathname belongs to a desktop-pet window route. */
export function isPetWindowRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return PET_WINDOW_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

export function PetWindowShell({
  petShell,
  children,
}: {
  /** Minimal provider tree rendered inside the pet overlay/popup windows. */
  petShell: React.ReactNode
  /** Full app runtime tree rendered everywhere else. */
  children: React.ReactNode
}) {
  const pathname = usePathname()
  return <>{isPetWindowRoute(pathname) ? petShell : children}</>
}
