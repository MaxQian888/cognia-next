"use client"

import dynamic from "next/dynamic"

const AppShellMobile = dynamic(
  () => import("@/components/app-shell-mobile").then((module) => module.AppShellMobile),
  { ssr: false }
)

export default function RouteBody() {
  return <AppShellMobile />
}
