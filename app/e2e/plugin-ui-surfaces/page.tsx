"use client"

import dynamic from "next/dynamic"
import { notFound } from "next/navigation"

// Keep the literal env access next to import(): Next's DefinePlugin folds out
// the entire fixture dependency graph in every non-E2E production build.
const Fixture =
  process.env.NEXT_PUBLIC_E2E === "1" ? dynamic(() => import("./fixture"), { ssr: false }) : null

export default function PluginUiSurfacesE2EPage() {
  if (!Fixture) notFound()
  return <Fixture />
}
