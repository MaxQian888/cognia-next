import { useState } from "react"
import { Alert, AlertDescription, AlertTitle, Button } from "@cognia/plugin-ui"

import {
  PENDING_SITE_QUESTIONS_KEY,
  type SiteAnswer,
  type SiteQuestion,
} from "@ext/src/lib/agent/site-permissions"
import type { BrowserApi } from "@ext/src/lib/browser-api"
import { useStoredValue } from "@ext/src/lib/panel/use-stored-value"

function parseQuestions(value: unknown): SiteQuestion[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is SiteQuestion =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as SiteQuestion).id === "string" &&
      typeof (entry as SiteQuestion).origin === "string"
  )
}

/** What the agent was about to do, in words — never the operation's token. */
export function siteOperationMessage(operation: string, message: (key: string) => string): string {
  switch (operation) {
    case "navigate":
    case "create_page":
      return message("siteOpNavigate")
    case "act":
    case "press_key":
    case "scroll":
    case "drag":
    case "set_files":
    case "handle_dialog":
    case "evaluate":
    case "set_storage":
    case "clear_storage":
    case "clear_cookies":
      return message("siteOpAct")
    default:
      return message("siteOpRead")
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/**
 * An agent waiting for the person's word on a site (ADR-0228 §7).
 *
 * Shown at the top of the panel, above everything else, because the agent is
 * blocked until it is answered and the operation behind it times out. The
 * answer is the person's click: allow this conversation once, always, or
 * never.
 */
export function SiteQuestions({ api }: { api: BrowserApi }) {
  const questions = useStoredValue(api, "session", PENDING_SITE_QUESTIONS_KEY, parseQuestions)
  const [answering, setAnswering] = useState<string | null>(null)
  if (questions.length === 0) return null

  const answer = async (id: string, choice: SiteAnswer) => {
    setAnswering(id)
    try {
      await api.answerSiteQuestion(id, choice)
    } finally {
      setAnswering(null)
    }
  }

  return (
    <div className="space-y-2" data-testid="site-questions">
      {questions.map((question) => (
        <Alert key={question.id} data-testid={`site-question-${question.id}`}>
          <AlertTitle>{api.message("siteQuestionTitle", [hostOf(question.origin)])}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              {api.message("siteQuestionDetail", [
                siteOperationMessage(question.operation, api.message),
              ])}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                disabled={answering === question.id}
                onClick={() => void answer(question.id, "once")}
                data-testid={`site-allow-once-${question.id}`}
              >
                {api.message("siteAllowOnce")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={answering === question.id}
                onClick={() => void answer(question.id, "always")}
                data-testid={`site-allow-always-${question.id}`}
              >
                {api.message("siteAllowAlways")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={answering === question.id}
                onClick={() => void answer(question.id, "never")}
                data-testid={`site-never-${question.id}`}
              >
                {api.message("siteNever")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  )
}
