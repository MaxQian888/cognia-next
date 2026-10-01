"use client"

import dynamic from "next/dynamic"
import { Suspense, useCallback } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useShellNav } from "@/components/shell/use-shell-nav"
import { useMessagePermalink } from "@/hooks/chat/use-message-permalink"
import { useSessionLink } from "@/hooks/chat/use-session-link"
import { PERMALINK_SESSION_PARAM } from "@/lib/chat/message-permalink"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import {
  readTargetedInviteLink,
  withoutTargetedInviteParams,
} from "@/lib/collab/targeted-invite-link"

// Platform shells are mutually exclusive at runtime but static imports made
// Turbopack compile both multi-thousand-module graphs for `/`. Keep the
// hydration snapshot lightweight, then request only the active shell.
const AppShellMobile = dynamic(
  () => import("@/components/app-shell-mobile").then((module) => module.AppShellMobile),
  { ssr: false }
)
const DesktopChatWorkspace = dynamic(
  () =>
    import("@/components/desktop/desktop-chat-workspace").then(
      (module) => module.DesktopChatWorkspace
    ),
  { ssr: false }
)
// Loaded only when a `chat.invited` notification link is actually in the URL:
// it pulls in the collaboration client and the shared-chat mirror, which the
// root route otherwise has no reason to hydrate.
const TargetedInviteAccept = dynamic(
  () =>
    import("@/components/chat/targeted-invite-accept").then(
      (module) => module.TargetedInviteAccept
    ),
  { ssr: false }
)

/**
 * Consumes `/?session=…&message=…` message permalinks (see
 * `lib/chat/message-permalink.ts`). Renders nothing — it exists so the chat
 * shells stay unaware of routing, and so `useSearchParams` has somewhere to
 * live under the `<Suspense>` boundary that a static export requires.
 */
function MessagePermalinkConsumer() {
  const t = useTranslations("chat.jump")
  const router = useRouter()
  // A link that cannot land is the common case for a shared permalink — the
  // conversation was deleted, the message compacted away, the link came from
  // another device. Silence there is indistinguishable from the app ignoring
  // the click.
  const onUnresolved = useCallback(() => toast.error(t("notFound")), [t])
  // Clear through the router, not `history.replaceState`. `replaceState` does
  // not notify Next, so `useSearchParams` kept returning the consumed link —
  // and pushing the SAME permalink again (terminal → "locate in conversation",
  // pressed twice for one tab) changed nothing the hook could observe, so it
  // re-armed only once per tab. `replace` is still not a history entry.
  const onConsumed = useCallback(() => router.replace("/", { scroll: false }), [router])
  useMessagePermalink({ params: useSearchParams(), onConsumed, onUnresolved })
  return null
}

/**
 * Consumes session-only `/?session=…` links (`buildSessionHref`): plan and
 * collaboration notifications, a memory's source, an issue run. Opens the
 * conversation, then drops only the `session` param.
 */
function SessionLinkConsumer() {
  const t = useTranslations("chat.jump")
  const router = useRouter()
  const pathname = usePathname() ?? "/"
  const params = useSearchParams()
  const { switchToDm } = useShellNav()
  const onConsumed = useCallback(() => {
    const rest = new URLSearchParams(params?.toString() ?? "")
    rest.delete(PERMALINK_SESSION_PARAM)
    const query = rest.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [router, pathname, params])
  const onUnresolved = useCallback(() => toast.error(t("notFound")), [t])
  useSessionLink({ params, onConsumed, onUnresolved, onOpened: switchToDm })
  return null
}

/**
 * Consumes `/?acceptInvite=…&org=…` (ADR-0207, `lib/collab/targeted-invite-link.ts`):
 * the link a `chat.invited` notification carries. The dialog asks before
 * accepting; once the link is spent its two params are dropped and any other
 * param is kept. Keyed by the link so a second invite gets a fresh dialog.
 */
function TargetedInviteConsumer() {
  const router = useRouter()
  const pathname = usePathname() ?? "/"
  const params = useSearchParams()
  const link = readTargetedInviteLink(params)
  const onSettled = useCallback(
    () => router.replace(withoutTargetedInviteParams(pathname, params), { scroll: false }),
    [router, pathname, params]
  )
  if (!link) return null
  return (
    <TargetedInviteAccept
      key={`${link.orgId}/${link.inviteId}`}
      inviteId={link.inviteId}
      orgId={link.orgId}
      onSettled={onSettled}
    />
  )
}

export default function Home() {
  // Layout, not runtime: a 375px browser window needs the phone shell too,
  // and it used to get the three-pane desktop workspace with no navigation
  // (`GuildRail` is `hidden md:flex`).
  const compact = useCompactLayout()
  return (
    <>
      {/* Static-export idiom (mirrors `/memory?id=`): `useSearchParams` throws
          during prerender unless it sits inside a Suspense boundary. */}
      <Suspense fallback={null}>
        <MessagePermalinkConsumer />
        <SessionLinkConsumer />
        <TargetedInviteConsumer />
      </Suspense>
      {compact ? <AppShellMobile /> : <DesktopChatWorkspace />}
    </>
  )
}
