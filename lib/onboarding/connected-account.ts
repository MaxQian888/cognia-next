import { providerIdForCredential, type Account, type ProviderId } from "@/types/subscription"

/**
 * What the sign-in step can show about an account it just connected.
 *
 * Each provider names the same two facts differently — Anthropic has `plan`,
 * Codex has `chatgptPlanType`, OpenCode Zen has neither — so the step would
 * otherwise carry a three-way branch purely to render one line. Pure and
 * separate from the component so the branch is testable without driving three
 * credential dialogs.
 */
export interface ConnectedAccountSummary {
  /** Which vault the account landed in — also the `defaultProvider` to set. */
  provider: ProviderId
  email?: string
  /** Subscription tier, when the provider reports one. */
  plan?: string
}

export function describeConnectedAccount(account: Account): ConnectedAccountSummary {
  const credential = account.credential
  const provider = providerIdForCredential(credential)
  switch (credential.provider) {
    case "anthropic":
      return { provider, email: credential.email, plan: credential.plan }
    case "codex":
      return { provider, email: credential.email, plan: credential.chatgptPlanType }
    case "opencode-zen":
      // No identity — a pasted key — but it does carry a plan tag ("zen" pay
      // per request vs "go" flat rate), which is the one thing worth showing.
      return { provider, plan: credential.plan }
    default:
      // An adopted OpenCode discovery is a pointer at another CLI's auth.json:
      // no identity and no tier of its own.
      return { provider }
  }
}
