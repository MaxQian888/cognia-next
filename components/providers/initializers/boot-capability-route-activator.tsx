"use client"

import { useEffect } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { loggers } from "@cognia/logging"

import { ensureBootCapability } from "@/lib/boot/capabilities"
import { resolveRouteBootCapabilities } from "@/lib/boot/route-capabilities"

const log = loggers.shell

/** Requests optional runtimes when navigation reaches one of their surfaces. */
export function BootCapabilityRouteActivator() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams.toString()

  useEffect(() => {
    for (const capability of resolveRouteBootCapabilities(pathname, search)) {
      void ensureBootCapability(capability).catch((error) => {
        log.warn("boot capability failed after route activation", {
          capability,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }, [pathname, search])

  return null
}

export default BootCapabilityRouteActivator
