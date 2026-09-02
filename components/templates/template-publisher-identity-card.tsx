"use client"

/**
 * The device's own template-publisher key, shown where package trust already
 * lives.
 *
 * Signing was the missing half of the package contract: `inspectTemplatePackage`
 * has verified Ed25519 signatures since it landed, and nothing could produce
 * one, so every package this app exported arrived as `unsigned` and the trust
 * ladder had exactly one rung on the way out.
 *
 * Three affordances, no more: see the fingerprint (so it can be read aloud or
 * pasted into a message), copy the public key (so a recipient can pin it), and
 * rotate. Rotation is behind a confirm because it is not reversible: packages
 * already signed under the old key keep verifying for whoever holds it, and
 * this device can never sign under it again.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { KeyRoundIcon, RotateCcwIcon } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  getOrCreatePublisherIdentity,
  getPublisherIdentity,
  publisherIdentityIsPersistent,
  rotatePublisherIdentity,
  type TemplatePublisherIdentity,
} from "@/lib/templates/publisher-identity"

export interface TemplatePublisherIdentityCardProps {
  /** Bumped by the caller to force a re-read after an export created the key. */
  refreshToken?: number
}

export function TemplatePublisherIdentityCard({
  refreshToken = 0,
}: TemplatePublisherIdentityCardProps) {
  const t = useTranslations("templateStudio.publisherIdentity")
  const [identity, setIdentity] = useState<TemplatePublisherIdentity | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)

  useEffect(() => {
    let active = true
    void getPublisherIdentity()
      .then((next) => {
        if (!active) return
        setIdentity(next)
        setLoaded(true)
      })
      .catch(() => {
        if (!active) return
        setIdentity(null)
        setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [refreshToken])

  const create = useCallback(async () => {
    try {
      setIdentity(await getOrCreatePublisherIdentity())
      toast.success(t("created"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }, [t])

  const rotate = useCallback(async () => {
    setRotating(true)
    try {
      setIdentity(await rotatePublisherIdentity())
      toast.success(t("rotated"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRotating(false)
      setConfirmRotate(false)
    }
  }, [t])

  const copyPublicKey = useCallback(async () => {
    if (!identity) return
    try {
      await navigator.clipboard.writeText(identity.publicKey)
      toast.success(t("copied"))
    } catch {
      toast.error(t("copyFailed"))
    }
  }, [identity, t])

  return (
    <div className="space-y-2 rounded-panel border p-3" data-testid="template-publisher-identity">
      <p className="flex items-center gap-2 text-sm font-medium">
        <KeyRoundIcon className="size-4" />
        {t("title")}
      </p>
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      {!loaded ? null : identity ? (
        <>
          <p className="text-sm">{identity.publisher}</p>
          <p
            className="break-all font-mono text-xs text-muted-foreground"
            data-testid="template-publisher-fingerprint"
          >
            {identity.fingerprint}
          </p>
          {/* A key kept only in process memory is a key that disappears on
              reload, and a user who signed a package yesterday would otherwise
              find themselves publishing under a new identity today with no
              explanation. */}
          {publisherIdentityIsPersistent() ? null : (
            <p className="text-xs text-destructive" data-testid="template-publisher-ephemeral">
              {t("ephemeral")}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void copyPublicKey()}>
              {t("copyPublicKey")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={rotating}
              onClick={() => setConfirmRotate(true)}
              data-testid="template-publisher-rotate"
            >
              <RotateCcwIcon className="size-3.5" />
              {t("rotate")}
            </Button>
          </div>
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void create()}
          data-testid="template-publisher-create"
        >
          {t("create")}
        </Button>
      )}

      <AlertDialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("rotateTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("rotateDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void rotate()}>{t("rotate")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
