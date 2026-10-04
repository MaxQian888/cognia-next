"use client"

import { Suspense, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"

function SchedulerRedirect() {
  const router = useRouter()
  const params = useSearchParams()
  const query = params.toString()
  useEffect(() => {
    router.replace(query ? `/me/scheduler?${query}` : "/me/scheduler")
  }, [query, router])
  return null
}

export default function RouteBody() {
  return (
    <Suspense fallback={null}>
      <SchedulerRedirect />
    </Suspense>
  )
}
