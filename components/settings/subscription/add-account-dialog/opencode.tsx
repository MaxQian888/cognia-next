"use client"

import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import { ManagedKeyAccountDialog, type ManagedKeyAccountDialogProps } from "./managed-key"

export type OpencodeAddAccountDialogProps = Omit<ManagedKeyAccountDialogProps, "definition">

/** Compatibility entry point; all managed-key behavior lives in the shared form. */
export function OpencodeAddAccountDialog(props: OpencodeAddAccountDialogProps) {
  return <ManagedKeyAccountDialog {...props} definition={getSubscriptionProvider("opencode")} />
}
