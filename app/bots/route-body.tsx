"use client"

import { BotConsole } from "@/components/bots/bot-console"
import { BotsMobileBody } from "@/components/mobile/bots/bots-mobile-body"
import type { BotsMobileBodyProps } from "@/components/mobile/bots/bots-mobile-body"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

export type RouteBodyProps = BotsMobileBodyProps
export default function RouteBody(props: RouteBodyProps) {
  const compact = useCompactLayout()
  return compact ? <BotsMobileBody {...props} /> : <BotConsole {...props} />
}
