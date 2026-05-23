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
import { ShieldAlert, ShieldCheck, AlertTriangle, CheckCircle, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
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

export interface ToolApprovalRequest {
  id: string
  toolName: string
  toolDescription: string
  args: Record<string, unknown>
  riskLevel: "low" | "medium" | "high"
  /** ACP permission options (if provided by the external agent). */
  acpOptions?: AcpPermissionOption[]
}

interface ToolApprovalDialogProps {
  request: ToolApprovalRequest | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onApprove: (id: string, alwaysAllow?: boolean) => void
  onDeny: (id: string) => void
  /** Callback for ACP option selection. */
  onSelectOption?: (id: string, optionId: string) => void
}

const riskConfig = {
  low: {
    icon: ShieldCheck,
    color: "text-green-600",
    bgColor: "bg-green-100",
    label: "Low Risk",
  },
  medium: {
    icon: AlertTriangle,
    color: "text-yellow-600",
    bgColor: "bg-yellow-100",
    label: "Medium Risk",
  },
  high: {
    icon: ShieldAlert,
    color: "text-red-600",
    bgColor: "bg-red-100",
    label: "High Risk",
  },
} as const

export function ToolApprovalDialog({
  request,
  open,
  onOpenChange,
  onApprove,
  onDeny,
  onSelectOption,
}: ToolApprovalDialogProps) {
  const t = useTranslations("tools")
  const [alwaysAllow, setAlwaysAllow] = useState(false)

  if (!request) return null

  const risk = riskConfig[request.riskLevel]
  const RiskIcon = risk.icon
  const hasAcpOptions = !!request.acpOptions && request.acpOptions.length > 0

  const handleApprove = () => {
    onApprove(request.id, alwaysAllow)
    setAlwaysAllow(false)
  }

  const handleDeny = () => {
    onDeny(request.id)
    setAlwaysAllow(false)
  }

  const handleOptionSelect = (optionId: string) => {
    onSelectOption?.(request.id, optionId)
    setAlwaysAllow(false)
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
                {risk.label}
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
                  >
                    {option.name}
                  </Button>
                ))}
              </div>
              <Button variant="ghost" onClick={handleDeny} className="sm:ml-auto">
                <XCircle className="h-4 w-4 mr-2" />
                {t("cancel")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={handleDeny}>
                <XCircle className="h-4 w-4 mr-2" />
                {t("deny")}
              </Button>
              <Button onClick={handleApprove}>
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
