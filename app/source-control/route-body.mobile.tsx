"use client"

import { SourceControlMobileBody } from "@/components/mobile/source-control/source-control-mobile-body"
import type { RouteBodyProps } from "./route-body"

export default function RouteBody(props: RouteBodyProps) {
  return <SourceControlMobileBody {...props} />
}
