"use client"

// Mobile onboarding mode chooser — the first screen an unpaired phone sees.
// Lets the user pick between standalone (BYOK, in-webview inference) and pairing
// with a Cognia desktop. The choice is persisted device-local via
// `setMobileRuntimeMode`; CompanionBootProvider reads it to decide routing.

import { useRouter } from "next/navigation"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { KeyRoundIcon, MonitorSmartphoneIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { setMobileRuntimeMode } from "@/lib/runtime/standalone-mode"

export function ModeChooser() {
  const t = useTranslations("mobile.welcome")
  const router = useRouter()
  const [busy, setBusy] = useState<"standalone" | "paired" | null>(null)

  const choose = async (mode: "standalone" | "paired") => {
    if (busy) return
    setBusy(mode)
    try {
      await setMobileRuntimeMode(mode)
      // Standalone → straight to BYOK key entry; paired → the pair flow.
      router.replace(mode === "standalone" ? "/me/providers" : "/pair")
    } catch {
      setBusy(null)
    }
  }

  return (
    <div
      className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col justify-center gap-6 p-6"
      data-testid="mobile-welcome"
    >
      <div className="flex flex-col gap-1 text-center">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRoundIcon className="size-4" aria-hidden />
            {t("byokTitle")}
          </CardTitle>
          <CardDescription>{t("byokDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            disabled={busy !== null}
            onClick={() => void choose("standalone")}
            data-testid="welcome-standalone"
          >
            {t("byokCta")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MonitorSmartphoneIcon className="size-4" aria-hidden />
            {t("pairTitle")}
          </CardTitle>
          <CardDescription>{t("pairDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy !== null}
            onClick={() => void choose("paired")}
            data-testid="welcome-pair"
          >
            {t("pairCta")}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
