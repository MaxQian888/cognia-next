# Cognia Diagnostic Service Helm chart

This chart deploys only the stateless diagnostic API and worker. PostgreSQL,
S3-compatible storage, OIDC, and KMS/HSM are production dependencies managed
outside the chart. Supply credentials through the pre-created Secret named by
`existingSecret.name`; the chart never creates or renders credential values.

## Install and upgrade

1. Back up PostgreSQL and confirm object-store versioning and lifecycle rules.
2. Create the credentials Secret and restrict its service-account access.
3. Replace all placeholder identity values and restrict `networkPolicy.egressCIDRs`.
4. Run `helm template` and `helm upgrade --install --atomic --wait`.

The pre-install/pre-upgrade migration Job runs the same immutable image with
`DIAGNOSTIC_MIGRATE_ONLY=true`. Migrations are expand-only: deploy schema additions,
then compatible code, and remove obsolete columns only after the documented
compatibility window.

## Rollback and recovery

Use `helm rollback --wait` to restore the previous Deployment. Do not roll back
the database migration: older releases must continue to read expanded schemas.
If processing is unhealthy, set `config.processingEnabled` to `"false"`; upload
receipts and encrypted artifacts remain durable for later processing. Restore
PostgreSQL using point-in-time recovery and recover object versions independently.
Validate backups and rollback in every release-candidate environment.

