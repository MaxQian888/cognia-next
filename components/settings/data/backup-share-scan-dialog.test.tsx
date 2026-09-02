/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { BackupShareScanDialog } from "./backup-share-scan-dialog"
import type { BackupShareDomainHits } from "@/lib/share/backup-share-gate"
import en from "@/i18n/messages/en/settings/data.json"
import zh from "@/i18n/messages/zh-CN/settings/data.json"
import { BACKUP_SHARE_DOMAINS } from "@/lib/share/backup-share-gate"
import { PII_KINDS } from "@cognia/redact"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const domains: BackupShareDomainHits[] = [
  { domain: "sessions", hits: 3, byKind: { EMAIL: 2, API_KEY: 1 } },
  { domain: "settings", hits: 1, byKind: { EMAIL: 1 } },
]

describe("BackupShareScanDialog", () => {
  it("lists every domain with its kind counts and keeps continue disabled until ticked", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    render(
      <BackupShareScanDialog
        open
        onOpenChange={() => {}}
        domains={domains}
        total={4}
        onConfirm={onConfirm}
      />
    )

    expect(screen.getByTestId("backup-share-scan-total").textContent).toBe(
      'total:{"total":4,"domains":2}'
    )
    expect(screen.getByTestId("backup-share-scan-domain-sessions").textContent).toContain(
      "domains.sessions"
    )
    expect(screen.getByTestId("backup-share-scan-domain-sessions").textContent).toContain(
      'kindCount:{"kind":"kinds.EMAIL","count":2}'
    )
    expect(screen.getByTestId("backup-share-scan-domain-settings")).toBeInTheDocument()

    const cont = screen.getByTestId("backup-share-scan-continue")
    expect(cont).toBeDisabled()
    await user.click(cont)
    expect(onConfirm).not.toHaveBeenCalled()

    await user.click(screen.getByTestId("backup-share-scan-confirm"))
    expect(cont).toBeEnabled()
    await user.click(cont)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("cancel closes without confirming and forgets the tick", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    const onConfirm = jest.fn()
    const view = render(
      <BackupShareScanDialog
        open
        onOpenChange={onOpenChange}
        domains={domains}
        total={4}
        onConfirm={onConfirm}
      />
    )
    await user.click(screen.getByTestId("backup-share-scan-confirm"))
    await user.click(screen.getByTestId("backup-share-scan-cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()

    view.rerender(
      <BackupShareScanDialog
        open={false}
        onOpenChange={onOpenChange}
        domains={domains}
        total={4}
        onConfirm={onConfirm}
      />
    )
    view.rerender(
      <BackupShareScanDialog
        open
        onOpenChange={onOpenChange}
        domains={domains}
        total={4}
        onConfirm={onConfirm}
      />
    )
    expect(screen.getByTestId("backup-share-scan-continue")).toBeDisabled()
  })

  it("has a label in both locales for every domain and every redactor kind", () => {
    for (const messages of [en, zh]) {
      const scan = messages.backup.shareScan
      for (const domain of BACKUP_SHARE_DOMAINS) {
        expect(scan.domains[domain]).toEqual(expect.any(String))
      }
      for (const kind of PII_KINDS) {
        expect(scan.kinds[kind]).toEqual(expect.any(String))
      }
    }
  })
})
