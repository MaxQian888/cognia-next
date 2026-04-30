// User-defined custom themes for the beautiful-HTML export. Persisted via
// Zustand's localStorage middleware so the user's custom palettes survive
// reloads. Each entry is a full `ThemeTokens` blob plus a label.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { ThemeTokens } from "@/lib/export/html/syntax-themes"
import { THEMES } from "@/lib/export/html/syntax-themes"

export interface CustomTheme {
  id: string
  name: string
  tokens: ThemeTokens
  createdAt: number
  updatedAt: number
}

interface CustomThemeState {
  themes: CustomTheme[]
  upsert: (
    theme: Omit<CustomTheme, "id" | "createdAt" | "updatedAt"> & { id?: string }
  ) => CustomTheme
  remove: (id: string) => void
  clone: (id: string, newName: string) => CustomTheme | null
}

function newId(): string {
  return "theme_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export const useCustomThemeStore = create<CustomThemeState>()(
  persist(
    (set, get) => ({
      themes: [],
      upsert: (input) => {
        const now = Date.now()
        const id = input.id ?? newId()
        const existing = get().themes.find((t) => t.id === id)
        const next: CustomTheme = {
          id,
          name: input.name,
          tokens: input.tokens,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }
        set((state) => ({
          themes: existing
            ? state.themes.map((t) => (t.id === id ? next : t))
            : [...state.themes, next],
        }))
        return next
      },
      remove: (id) => set((state) => ({ themes: state.themes.filter((t) => t.id !== id) })),
      clone: (id, newName) => {
        const src = get().themes.find((t) => t.id === id)
        if (!src) return null
        return get().upsert({ name: newName, tokens: { ...src.tokens } })
      },
    }),
    { name: "cognia-custom-themes" }
  )
)

/** Build a fresh `ThemeTokens` seeded from a built-in theme. */
export function seedTokens(base: keyof typeof THEMES = "light"): ThemeTokens {
  return { ...THEMES[base] }
}
