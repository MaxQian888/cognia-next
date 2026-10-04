"use client"

import { MobileRunsList } from "@/components/mobile/workflow/mobile-runs-list"
import type { RouteBodyProps } from "./route-body"

export default function RouteBody(props: RouteBodyProps) {
  return <MobileRunsList {...props} />
}
