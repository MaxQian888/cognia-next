/**
 * A Cognia provider/model an external agent runs on through the local gateway
 * (ADR-0090, 2026-09-11 amendment). Nonsecret: the upstream credential stays
 * in Cognia and reaches the task through its gateway lease.
 *
 * `accountId` omitted means the provider default at task start; a concrete id
 * pins the task to that subscription account; `null` selects the manual API
 * settings.
 */
export interface ExternalAgentCogniaModelBinding {
  providerId: string
  modelId: string
  accountId?: string | null
}
