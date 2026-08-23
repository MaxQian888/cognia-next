import type { HostDispatchDomain, HostDispatchJobRow } from "@/types/placement/host-dispatch"

export type HostDispatchDeliveryOutcome = "succeeded" | "awaiting-result"
export type HostDispatchDelivery = (job: HostDispatchJobRow) => Promise<HostDispatchDeliveryOutcome>

const deliveries = new Map<HostDispatchDomain, HostDispatchDelivery>()

/** Register one domain adapter. This is also the extension seam for schedule-handoff. */
export function registerHostDispatchDelivery(
  domain: HostDispatchDomain,
  delivery: HostDispatchDelivery
): () => void {
  deliveries.set(domain, delivery)
  return () => {
    if (deliveries.get(domain) === delivery) deliveries.delete(domain)
  }
}

export async function deliverHostDispatch(
  job: HostDispatchJobRow
): Promise<HostDispatchDeliveryOutcome> {
  const delivery = deliveries.get(job.domain)
  if (!delivery) throw new HostDispatchDeliveryError("unsupported", false, job.domain)
  return delivery(job)
}

export class HostDispatchDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string
  ) {
    super(message)
    this.name = "HostDispatchDeliveryError"
  }
}

export function __resetHostDispatchDeliveriesForTesting(): void {
  deliveries.clear()
}
