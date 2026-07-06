"use client"

/**
 * Client wrapper for RootProvider (D8): the custom static SearchDialog is a
 * function and cannot cross the server→client boundary from the [lang]
 * layout, so the provider itself is a client component.
 */

import type { ReactNode } from "react"
import { RootProvider } from "fumadocs-ui/provider/next"

import { i18nUI } from "@/lib/layout.shared"
import StaticSearchDialog from "./search-dialog"

export function Provider({ lang, children }: { lang: string; children: ReactNode }) {
  return (
    <RootProvider i18n={i18nUI.provider(lang)} search={{ SearchDialog: StaticSearchDialog }}>
      {children}
    </RootProvider>
  )
}
