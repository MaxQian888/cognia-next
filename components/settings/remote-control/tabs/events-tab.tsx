"use client"

import { useTranslations } from "next-intl"
import { SendIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { emitSchedulerEvent, type SchedulerEventType } from "@/lib/scheduler/event-integration"

const EVENT_TYPES: SchedulerEventType[] = [
  "session:created",
  "session:completed",
  "session:deleted",
  "sync:started",
  "sync:completed",
  "sync:failed",
  "backup:needed",
  "backup:completed",
  "workflow:completed",
  "agent:completed",
  "connection:outbound:send",
  "connection:scheduled:digest",
  "custom",
]

const EVENT_KEY_MAP: Record<SchedulerEventType, string> = {
  "session:created": "sessionCreated",
  "session:completed": "sessionCompleted",
  "session:deleted": "sessionDeleted",
  "sync:started": "syncStarted",
  "sync:completed": "syncCompleted",
  "sync:failed": "syncFailed",
  "backup:needed": "backupNeeded",
  "backup:completed": "backupCompleted",
  "workflow:completed": "workflowCompleted",
  "agent:completed": "agentCompleted",
  "connection:outbound:send": "connectionOutboundSend",
  "connection:scheduled:digest": "connectionScheduledDigest",
  custom: "custom",
}

export function EventsTab() {
  const t = useTranslations("settings.remoteControl.events")

  const onEmitTest = async (eventType: SchedulerEventType) => {
    try {
      await emitSchedulerEvent(eventType, {
        source: "remote-control-test",
        synthetic: true,
      })
      toast.success(t("testEventDispatched"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">{t("heading")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {EVENT_TYPES.map((eventType) => (
            <li key={eventType} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <div className="flex-1 min-w-0">
                <code className="text-xs font-mono">{eventType}</code>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t(`types.${EVENT_KEY_MAP[eventType]}` as never)}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => onEmitTest(eventType)}>
                <SendIcon className="mr-2 h-3.5 w-3.5" />
                {t("emitTest")}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
