"use client"

import { IssuesMobileBody } from "@/components/mobile/issues/issues-mobile-body"
import type { RouteBodyProps } from "./route-body"

export default function RouteBody(props: RouteBodyProps) {
  return <IssuesMobileBody initialSelectedId={props.initialSelectedId} />
}
