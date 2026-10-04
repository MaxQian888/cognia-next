"use client"

import { Suspense } from "react"
import { TemplatesMobileBody } from "@/components/mobile/templates/templates-mobile-body"

export default function RouteBody() {
  return (
    <Suspense fallback={null}>
      <TemplatesMobileBody />
    </Suspense>
  )
}
