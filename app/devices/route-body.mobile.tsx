"use client"

import { Suspense } from "react"
import { DevicesMobileBody } from "@/components/mobile/devices/devices-mobile-body"

export default function RouteBody() {
  return (
    <Suspense fallback={null}>
      <DevicesMobileBody />
    </Suspense>
  )
}
