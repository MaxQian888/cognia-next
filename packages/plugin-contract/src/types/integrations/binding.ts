/** Host-owned Inbox binding for a conversation projected from Integration events. */
export interface IntegrationBinding {
  pluginId: string
  integrationId: string
  accountId: string
  projectionId: string
  threadKey: string
  resourceKind?: string
  resourceId?: string
}
