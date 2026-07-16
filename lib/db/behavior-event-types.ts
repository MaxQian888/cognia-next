export interface BehaviorEventRow {
  id: string
  eventName: string
  at: number
  sessionId?: string
  attributes: Record<string, string | number | boolean>
}
