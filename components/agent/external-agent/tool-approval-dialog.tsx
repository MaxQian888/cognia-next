"use client"

/**
 * ACP-aware Tool Approval Dialog.
 *
 * This is the external-agent variant: it accepts an `AcpPermissionRequest`
 * shape (raw input + ACP option list) and emits decisions back to the
 * external-agent manager via `onApprove` / `onDeny` / `onSelectOption`.
 *
 * The Claude-SDK approval dialog (`components/chat/tool-approval-dialog.tsx`)
 * is intentionally kept separate — it handles the in-process Claude tool
 * approval flow with `PendingApproval` / `ApprovalDecision` types.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  CheckCircle,
  MessageCircleQuestion,
  Timer,
  XCircle,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { CodeBlock } from "@/components/ai-elements/code-block"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { AcpPermissionOption } from "@/types/agent/external-agent"

/** One interactive question (Codex `item/tool/requestUserInput` wire shape). */
export interface ToolApprovalUserInputQuestion {
  id: string
  header?: string
  question: string
  options?: Array<{ label: string; description?: string }> | null
  isOther?: boolean
  isSecret?: boolean
}

export interface ToolApprovalRequest {
  id: string
  toolName: string
  toolDescription: string
  args: Record<string, unknown>
  riskLevel: "low" | "medium" | "high"
  /** ACP permission options (if provided by the external agent). */
  acpOptions?: AcpPermissionOption[]
  /**
   * Interactive question payload — when present the dialog renders question
   * mode (per-question choices + free text) instead of the approve/deny pair.
   */
  userInput?: {
    questions: ToolApprovalUserInputQuestion[]
    autoResolutionMs?: number
  }
}

interface ToolApprovalDialogProps {
  request: ToolApprovalRequest | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onApprove: (id: string, alwaysAllow?: boolean) => void
  onDeny: (id: string) => void
  /** Callback for ACP option selection. */
  onSelectOption?: (id: string, optionId: string) => void
  /** Callback for interactive question answers (question id → answers). */
  onSubmitAnswers?: (id: string, answers: Record<string, string[]>) => void
}

/** RadioGroup sentinel for the free-form "other" choice. */
const OTHER_SENTINEL = "__other__"

const riskConfig = {
  low: { icon: ShieldCheck, color: "text-green-600", bgColor: "bg-green-100", labelKey: "riskLow" },
  medium: {
    icon: AlertTriangle,
    color: "text-yellow-600",
    bgColor: "bg-yellow-100",
    labelKey: "riskMedium",
  },
  high: { icon: ShieldAlert, color: "text-red-600", bgColor: "bg-red-100", labelKey: "riskHigh" },
} as const

export function ToolApprovalDialog({
  request,
  open,
  onOpenChange,
  onApprove,
  onDeny,
  onSelectOption,
  onSubmitAnswers,
}: ToolApprovalDialogProps) {
  const t = useTranslations("tools")
  const tUserInput = useTranslations("externalAgent.userInput")
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  // Guard against a double-response: this dialog gates a security-sensitive
  // permission, and `onApprove`/`onDeny` are async in the manager, so a second
  // click before the dialog tears down would fire two responses for one request.
  // Derived (not effect-reset) so a new request id automatically re-enables.
  const [submittedId, setSubmittedId] = useState<string | null>(null)
  // Question-mode state: per-question selected option / free-typed text, keyed
  // by `${requestId}:${questionId}` so a new request never inherits answers.
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({})
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({})

  if (!request) return null

  const risk = riskConfig[request.riskLevel]
  const RiskIcon = risk.icon
  const hasAcpOptions = !!request.acpOptions && request.acpOptions.length > 0
  const questions = request.userInput?.questions ?? []
  const isQuestionMode = questions.length > 0
  const submitting = submittedId === request.id

  const answerKey = (questionId: string) => `${request.id}:${questionId}`

  const handleApprove = () => {
    if (submitting) return
    setSubmittedId(request.id)
    onApprove(request.id, alwaysAllow)
    setAlwaysAllow(false)
  }

  const handleDeny = () => {
    if (submitting) return
    setSubmittedId(request.id)
    onDeny(request.id)
    setAlwaysAllow(false)
  }

  const handleOptionSelect = (optionId: string) => {
    if (submitting) return
    setSubmittedId(request.id)
    onSelectOption?.(request.id, optionId)
    setAlwaysAllow(false)
  }

  const handleSubmitAnswers = () => {
    if (submitting) return
    const answers: Record<string, string[]> = {}
    for (const question of questions) {
      const selected = selectedAnswers[answerKey(question.id)]
      const typed = otherAnswers[answerKey(question.id)]?.trim()
      if (selected && selected !== OTHER_SENTINEL) {
        answers[question.id] = [selected]
      } else if (typed) {
        answers[question.id] = [typed]
      } else {
        answers[question.id] = []
      }
    }
    setSubmittedId(request.id)
    onSubmitAnswers?.(request.id, answers)
  }

  const answeredAll = questions.every((question) => {
    const selected = selectedAnswers[answerKey(question.id)]
    if (selected && selected !== OTHER_SENTINEL) return true
    return !!otherAnswers[answerKey(question.id)]?.trim()
  })

  if (isQuestionMode) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[500px]" data-testid="user-input-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircleQuestion className="h-5 w-5" />
              {tUserInput("title")}
            </DialogTitle>
            <DialogDescription>{tUserInput("description")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {typeof request.userInput?.autoResolutionMs === "number" && (
              <Badge variant="secondary" className="gap-1" data-testid="user-input-auto-resolve">
                <Timer className="h-3 w-3" />
                {tUserInput("autoResolveIn", {
                  seconds: Math.ceil(request.userInput.autoResolutionMs / 1000),
                })}
              </Badge>
            )}
            {questions.map((question) => {
              const key = answerKey(question.id)
              const hasOptions = !!question.options && question.options.length > 0
              const selected = selectedAnswers[key] ?? ""
              const showOtherInput = !hasOptions || selected === OTHER_SENTINEL
              return (
                <div key={question.id} className="space-y-2" data-testid="user-input-question">
                  {question.header && (
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {question.header}
                    </p>
                  )}
                  <p className="text-sm font-medium">{question.question}</p>
                  {hasOptions && (
                    <RadioGroup
                      value={selected}
                      onValueChange={(value) =>
                        setSelectedAnswers((prev) => ({ ...prev, [key]: value }))
                      }
                    >
                      {question.options!.map((option) => (
                        <div key={option.label} className="flex items-start gap-2">
                          <RadioGroupItem
                            value={option.label}
                            id={`${key}:${option.label}`}
                            className="mt-0.5"
                          />
                          <Label htmlFor={`${key}:${option.label}`} className="font-normal">
                            <span>{option.label}</span>
                            {option.description && (
                              <span className="block text-xs text-muted-foreground">
                                {option.description}
                              </span>
                            )}
                          </Label>
                        </div>
                      ))}
                      {question.isOther && (
                        <div className="flex items-start gap-2">
                          <RadioGroupItem
                            value={OTHER_SENTINEL}
                            id={`${key}:${OTHER_SENTINEL}`}
                            className="mt-0.5"
                          />
                          <Label
                            htmlFor={`${key}:${OTHER_SENTINEL}`}
                            className="font-normal text-muted-foreground"
                          >
                            {tUserInput("other")}
                          </Label>
                        </div>
                      )}
                    </RadioGroup>
                  )}
                  {showOtherInput && (
                    <Input
                      type={question.isSecret ? "password" : "text"}
                      value={otherAnswers[key] ?? ""}
                      onChange={(e) =>
                        setOtherAnswers((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      placeholder={tUserInput("otherPlaceholder")}
                      data-testid="user-input-other"
                    />
                  )}
                </div>
              )
            })}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleDeny} disabled={submitting}>
              <XCircle className="h-4 w-4 mr-2" />
              {tUserInput("skip")}
            </Button>
            <Button
              onClick={handleSubmitAnswers}
              disabled={submitting || !answeredAll}
              data-testid="user-input-submit"
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              {tUserInput("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5" />
            {t("approvalRequired")}
          </DialogTitle>
          <DialogDescription>{t("approvalDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{request.toolName}</span>
              <Badge variant="outline" className={`${risk.color} ${risk.bgColor} border-0`}>
                <RiskIcon className="h-3 w-3 mr-1" />
                {t(risk.labelKey)}
              </Badge>
            </div>
            {request.toolDescription && (
              <p className="text-sm text-muted-foreground">{request.toolDescription}</p>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t("parameters")}</h4>
            <div className="rounded-md bg-muted/50">
              <CodeBlock code={JSON.stringify(request.args, null, 2)} language="json" />
            </div>
          </div>

          {request.riskLevel === "low" && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="always-allow"
                checked={alwaysAllow}
                onCheckedChange={(checked) => setAlwaysAllow(checked === true)}
              />
              <label
                htmlFor="always-allow"
                className="text-sm text-muted-foreground cursor-pointer"
              >
                {t("alwaysAllowTool")}
              </label>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:gap-0">
          {hasAcpOptions ? (
            <>
              <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                {request.acpOptions!.map((option) => (
                  <Button
                    key={option.optionId}
                    variant={option.isDefault ? "default" : "outline"}
                    onClick={() => handleOptionSelect(option.optionId)}
                    title={option.description}
                    disabled={submitting}
                  >
                    {option.name}
                  </Button>
                ))}
              </div>
              <Button
                variant="ghost"
                onClick={handleDeny}
                className="sm:ml-auto"
                disabled={submitting}
              >
                <XCircle className="h-4 w-4 mr-2" />
                {t("cancel")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={handleDeny} disabled={submitting}>
                <XCircle className="h-4 w-4 mr-2" />
                {t("deny")}
              </Button>
              <Button onClick={handleApprove} disabled={submitting}>
                <CheckCircle className="h-4 w-4 mr-2" />
                {t("approve")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ToolApprovalDialog
