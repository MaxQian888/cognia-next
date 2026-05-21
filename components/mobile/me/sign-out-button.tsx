"use client"

/**
 * Destructive "退出登录" button at the bottom of the mobile profile
 * screen. Hooks into `useCompanionSignOut` which gates the action behind
 * `verify()` (biometric prompt — skipped when policy is off or device
 * has no biometric enrolled), then clears both the Anthropic credential
 * and the pairing JWT and navigates to `/pair`.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { LogOutIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { useCompanionSignOut } from "@/hooks/companion/use-companion-sign-out"
import { cn } from "@/lib/utils"

export interface SignOutButtonProps {
  className?: string
}

export function SignOutButton({ className }: SignOutButtonProps) {
  const t = useTranslations("mobile.me.signOut")
  const { signOut, pending } = useCompanionSignOut({
    prompt: {
      reason: t("biometricReason"),
      title: t("biometricTitle"),
      description: t("biometricDescription"),
    },
  })
  const [open, setOpen] = useState(false)

  const onConfirm = useCallback(async () => {
    const outcome = await signOut()
    if (outcome.kind === "ok") {
      // The hook already routes us to /pair; the toast is a courtesy.
      toast.success(t("successToast"))
      setOpen(false)
      return
    }
    setOpen(false)
    if (outcome.reason === "cancelled") return
    if (outcome.reason === "lockout") {
      toast.error(t("lockoutToast"))
      return
    }
    toast.error(t("errorToast", { reason: outcome.message ?? "" }))
  }, [signOut, t])

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          size="lg"
          className={cn("w-full justify-center gap-2", className)}
          data-testid="me-sign-out"
          disabled={pending}
        >
          <LogOutIcon className="size-4" aria-hidden="true" />
          {t("cta")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("confirmDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="me-sign-out-cancel">{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(e) => {
              e.preventDefault()
              void onConfirm()
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="me-sign-out-confirm"
          >
            {pending ? t("pending") : t("confirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
