"use client"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, type ReactNode } from "react"

import { PageLoading } from "@/components/ui/loading-states"
import { isDevLocalAccount } from "@/lib/accounts/dev-auto-unlock"
import { ONBOARDING_ROUTE } from "@/lib/onboarding/route"
import { useOnboardingGate } from "@/hooks/onboarding/use-onboarding-gate"
import { useAccountStore } from "@/stores/account/account-store"

/**
 * Routes first-run devices into `/onboarding` (ADR-0122).
 *
 * **Why a provider instead of a route guard.** The app is a static export
 * (`output: "export"`), so there is no middleware and no server-side redirect:
 * the decision has to happen client-side, after several providers have
 * asynchronously settled. Putting it in one place — rather than wrapping every
 * page that needs protecting — is what keeps a newly added route from silently
 * missing the guard.
 *
 * **Mount position is the contract.** It belongs *after* `SettingsHydrator`
 * (it reads the settings row) and *before* the shells, so a first-run user
 * never paints the app behind the flow. It deliberately sits below
 * `RecoveryBootGate`: safe mode is about the app being broken, which outranks
 * the question of whether the user is new.
 *
 * While resolving it renders the boot screen (its `preferences` step), matching
 * `RecoveryBootGate`. It used to render `null` so that no spinner would flash on
 * a healthy boot — but the account gate has just been showing that very screen,
 * so a blank frame here *was* the flash. The screen carries its state across
 * mounts (`lib/boot/boot-progress.ts`), so this is a continuation, not a new
 * loader; the resolve is still one Dexie count plus the already-in-flight
 * settings hydration.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { status } = useOnboardingGate()
  const router = useRouter()
  const pathname = usePathname()
  const onOnboardingRoute = pathname?.startsWith(ONBOARDING_ROUTE) ?? false
  // The disposable development account that `pnpm dev` provisions for a fresh
  // browser profile is, by construction, always a first run: no settings row,
  // no sessions. Routing it into the flow would put the setup wizard back in
  // front of every new browser, which is the cost this account exists to
  // remove. Scoped to that one account id rather than to development at
  // large, so an account created by hand still gets the real first run, and
  // `/onboarding` itself stays reachable below for a deliberate visit.
  const devLocalAccount = useAccountStore((state) =>
    isDevLocalAccount(state.unlockedAccountId ?? state.activeAccountId)
  )

  useEffect(() => {
    if (devLocalAccount) return
    if (status !== "enter" || onOnboardingRoute) return
    router.replace(ONBOARDING_ROUTE)
  }, [devLocalAccount, status, onOnboardingRoute, router])

  // The flow's own route renders regardless of the verdict: entering it from
  // Settings ("re-run setup") is a deliberate revisit by someone the gate has
  // already decided is onboarded, and blocking that would make the re-run
  // entry point dead.
  if (onOnboardingRoute) return <>{children}</>

  if (devLocalAccount) return <>{children}</>

  // Hold the app back while the verdict resolves — and, on `enter`, for the
  // frame it takes the replace to land, so a first-run user never sees the
  // chat shell flash behind the flow. Same screen in both cases: the boot is
  // still one continuous wait from where the user sits.
  if (status === "resolving" || status === "enter") {
    return <PageLoading variant="workspace" milestone="preferences" allowReload />
  }

  return <>{children}</>
}
