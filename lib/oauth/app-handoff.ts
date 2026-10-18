/**
 * Which identity provider's own app can run a phone sign-in, and the link
 * that hands the request to it.
 *
 * On a phone where the person already uses Feishu, a browser tab is the wrong
 * place to sign in: it shows Feishu's web login form, and the person types a
 * phone number and an SMS code for an account the phone is already signed in
 * to. Feishu's own guidance for native apps is the standard authorize request
 * opened through an Applink, which the Feishu app shows in its WebView with a
 * one-tap consent (the LarkSSO SDK is retired for this).
 *
 * The whole Cognia authorize request is handed over, not just Feishu's: the
 * issuer's sign-in page, Feishu's consent and the issuer's callback then run
 * in the same WebView, so the state cookie the issuer checks on its callback
 * is where it was set. The issuer's return page sends the code back to the
 * app through `cn.cognia.app:/auth/callback`, as it does from a browser tab.
 */

/**
 * An app the native plugin may hand a link to: Feishu for a sign-in, or
 * RustDesk for a remote desktop (ADR-0234 Phase 5). The plugin fixes each
 * target's package and accepted link shape natively.
 */
export type AppHandoffTarget = "feishu" | "rustdesk"

/** Feishu opens a web page in its own WebView at this Applink path. */
const FEISHU_WEB_URL_APPLINK = "https://applink.feishu.cn/client/web_url/open"

/**
 * The provider's app link for this authorize request, or null when the
 * request names no provider whose app can run it. The official issuer carries
 * the provider the person picked as `provider` (lib/logto/client.ts).
 */
export function appHandoffFor(
  authorizeUrl: string
): { target: AppHandoffTarget; url: string } | null {
  let provider: string | null
  try {
    provider = new URL(authorizeUrl).searchParams.get("provider")
  } catch {
    return null
  }
  if (provider !== "feishu") return null
  return { target: "feishu", url: feishuWebUrlApplink(authorizeUrl) }
}

/**
 * `https://applink.feishu.cn/client/web_url/open?mode=window&url=…`. The
 * authorize URL is encoded once, as a whole: its own query values are
 * already encoded, and encoding them again breaks the redirect URI match.
 */
export function feishuWebUrlApplink(pageUrl: string): string {
  const link = new URL(FEISHU_WEB_URL_APPLINK)
  link.searchParams.set("mode", "window")
  link.searchParams.set("url", pageUrl)
  return link.toString()
}
