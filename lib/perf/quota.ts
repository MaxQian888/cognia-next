import {
  CogniaAccountRegistryDB,
  type PerformanceQuotaReservationRow,
} from "@/lib/accounts/account-db"

export const PERFORMANCE_ACCOUNT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024

export class PerformanceQuotaExceededError extends Error {
  constructor() {
    super("performance-account-quota-exceeded")
    this.name = "PerformanceQuotaExceededError"
  }
}

export interface ReconciledCaptureUsage {
  targetDatabase: string
  captureId: string
  bytes: number
}

export class PerformanceQuotaManager {
  constructor(private readonly db = new CogniaAccountRegistryDB()) {}

  close(): void {
    this.db.close()
  }

  async usage(accountId: string): Promise<number> {
    const rows = await this.db.performanceQuotaReservations
      .where("accountId")
      .equals(accountId)
      .toArray()
    return rows.reduce(
      (total, row) => total + (row.status === "reserved" ? row.reservedBytes : row.committedBytes),
      0
    )
  }

  async reserve(input: {
    accountId: string
    targetDatabase: string
    captureId: string
    worstCaseBytes: number
    now?: number
  }): Promise<PerformanceQuotaReservationRow> {
    if (!Number.isSafeInteger(input.worstCaseBytes) || input.worstCaseBytes <= 0) {
      throw new Error("performance-quota-reservation-size-invalid")
    }
    const now = input.now ?? Date.now()
    const row: PerformanceQuotaReservationRow = {
      id: crypto.randomUUID(),
      accountId: input.accountId,
      targetDatabase: input.targetDatabase,
      captureId: input.captureId,
      status: "reserved",
      reservedBytes: input.worstCaseBytes,
      committedBytes: 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.db.transaction("rw", this.db.performanceQuotaReservations, async () => {
      const used = await this.usage(input.accountId)
      if (used + input.worstCaseBytes > PERFORMANCE_ACCOUNT_QUOTA_BYTES) {
        throw new PerformanceQuotaExceededError()
      }
      await this.db.performanceQuotaReservations.add(row)
    })
    return row
  }

  async commit(reservationId: string, actualBytes: number, now = Date.now()): Promise<void> {
    await this.db.transaction("rw", this.db.performanceQuotaReservations, async () => {
      const row = await this.db.performanceQuotaReservations.get(reservationId)
      if (!row) throw new Error("performance-quota-reservation-missing")
      if (
        !Number.isSafeInteger(actualBytes) ||
        actualBytes < 0 ||
        actualBytes > row.reservedBytes
      ) {
        throw new Error("performance-quota-commit-size-invalid")
      }
      await this.db.performanceQuotaReservations.put({
        ...row,
        status: "committed",
        committedBytes: actualBytes,
        updatedAt: now,
      })
    })
  }

  async abandon(reservationId: string): Promise<void> {
    await this.db.performanceQuotaReservations.delete(reservationId)
  }

  /** Call only after target-database payload deletion has committed. */
  async releaseCapture(
    accountId: string,
    targetDatabase: string,
    captureId: string
  ): Promise<void> {
    const rows = await this.db.performanceQuotaReservations
      .where("accountId")
      .equals(accountId)
      .filter((row) => row.targetDatabase === targetDatabase && row.captureId === captureId)
      .primaryKeys()
    await this.db.performanceQuotaReservations.bulkDelete(rows)
  }

  async reconcile(accountId: string, actual: readonly ReconciledCaptureUsage[]): Promise<void> {
    const actualByScope = new Map(
      actual.map((item) => [`${item.targetDatabase}\u001f${item.captureId}`, item.bytes])
    )
    await this.db.transaction("rw", this.db.performanceQuotaReservations, async () => {
      const rows = await this.db.performanceQuotaReservations
        .where("accountId")
        .equals(accountId)
        .toArray()
      for (const row of rows) {
        const bytes = actualByScope.get(`${row.targetDatabase}\u001f${row.captureId}`)
        if (bytes === undefined) {
          await this.db.performanceQuotaReservations.delete(row.id)
        } else {
          await this.db.performanceQuotaReservations.put({
            ...row,
            status: "committed",
            reservedBytes: Math.max(row.reservedBytes, bytes),
            committedBytes: bytes,
            updatedAt: Date.now(),
          })
        }
      }
    })
  }
}
