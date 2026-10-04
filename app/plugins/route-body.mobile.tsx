"use client"

import { Suspense } from "react"
import { PluginsMobileBody } from "@/components/mobile/plugins/plugins-mobile-body"

export default function RouteBody() {
  return (
    <div className="h-full min-h-0 w-full flex-1">
      <Suspense fallback={null}>
        <PluginsMobileBody />
      </Suspense>
    </div>
  )
}
