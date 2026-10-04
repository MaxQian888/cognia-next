/**
 * Settings → the cloud gate: "show the sign-in screen now".
 *
 * Signing in lives in one place, the gate (`components/account/cloud-sign-in-gate.tsx`),
 * which owns the drivers, the deep-link wait and the settle step. Once the
 * official account's screen has been answered the gate never shows it on its
 * own, so Settings → Account asks for it through this bus instead of
 * reloading the app. The gate answers only for the profile it is serving.
 */

const REQUEST_EVENT = "cognia:cloud-sign-in-request"

export interface CloudSignInRequest {
  localAccountId: string
}

/** Ask the gate to show its sign-in screen for this profile. */
export function requestCloudSignIn(localAccountId: string): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<CloudSignInRequest>(REQUEST_EVENT, { detail: { localAccountId } })
  )
}

export function subscribeCloudSignInRequest(
  listener: (request: CloudSignInRequest) => void
): () => void {
  if (typeof window === "undefined") return () => {}
  const onRequest = (event: Event) => {
    const detail = (event as CustomEvent<CloudSignInRequest>).detail
    if (detail && typeof detail.localAccountId === "string") listener(detail)
  }
  window.addEventListener(REQUEST_EVENT, onRequest)
  return () => window.removeEventListener(REQUEST_EVENT, onRequest)
}
