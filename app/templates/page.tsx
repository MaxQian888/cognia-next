"use client"

/**
 * Unified template platform (ADR-0100).
 *
 * Two things this route owes the Studio. It reads `?definition=` through
 * `useSearchParams`, which a static export requires inside a Suspense boundary,
 * and it picks the layout: below `md` the desktop three-pane Studio has no
 * usable shape, so the phone-shaped catalog renders instead. Keyed on width
 * rather than on the Capacitor runtime, so a 375px browser window gets it too.
 */

import { Suspense } from "react"

import { TemplatesMobileBody } from "@/components/mobile/templates/templates-mobile-body"
import { TemplateStudio } from "@/components/templates/template-studio"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

function TemplatesPageInner() {
  const compact = useCompactLayout()
  return compact ? <TemplatesMobileBody /> : <TemplateStudio />
}

export default function TemplatesPage() {
  return (
    <Suspense fallback={null}>
      <TemplatesPageInner />
    </Suspense>
  )
}
