"use client"

/**
 * Keeps the SFTP transfer queue moving for as long as the app is open
 * (ADR-0162).
 *
 * The pump lives here rather than inside the panel that shows transfers,
 * because a transfer that stops when you navigate away is a transfer that
 * mostly does not finish. The queue is durable either way, so the worst case is
 * a paused row rather than a lost one, but pausing every download because
 * somebody opened settings is not a queue anybody would trust.
 *
 * Mounted behind the unlocked account for the same reason every other Dexie
 * worker is: before an account is unlocked there is no database to read a row
 * out of, and starting the poll early only produces a loop that finds nothing.
 */

import { useEffect } from "react"

import { isTauri } from "@/lib/tauri"
import { startSftpTransferPump } from "@/lib/sftp/transfer-queue"
import { useAccountStore } from "@/stores/account/account-store"

export function SftpTransferInitializer() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)

  useEffect(() => {
    if (!unlockedAccountId) return
    // The desktop is the host, so its transfers need no approval from anyone.
    // Every other shell is a paired device and must present one, which is what
    // parks a transfer instead of failing it when nobody has given one yet.
    return startSftpTransferPump({ requiresApproval: !isTauri() })
  }, [unlockedAccountId])

  return null
}

export default SftpTransferInitializer
