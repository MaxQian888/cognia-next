// The pure half of the rendezvous health check (ADR-0170) is shared with the
// public status Worker and probe, so it is owned by `@cognia/status-contract`
// in cognia-labs/cognia-services and installed at the pinned revision
// (integrations/cognia-services.json).
export * from "@cognia/status-contract/relay-health"
