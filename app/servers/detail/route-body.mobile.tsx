"use client"

import { ServerDetailMobileBody } from "@/components/mobile/servers/server-detail-mobile-body"
import type { RouteBodyProps } from "./route-body"

export default function RouteBody(props: RouteBodyProps) {
  return <ServerDetailMobileBody {...props} />
}
