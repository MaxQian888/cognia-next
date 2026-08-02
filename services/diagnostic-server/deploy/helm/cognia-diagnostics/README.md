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

### Required values

The chart fails at template time — not at pod start — if artifact storage is
unconfigured. Set exactly one of:

- `config.s3Endpoint` — S3-compatible object storage (the normal choice).
- `config.objectStoreLocalDir` — a PersistentVolume path, single replica only.

## Migrations

The pre-install/pre-upgrade migration Job runs the same immutable image with
`DIAGNOSTIC_MIGRATE_ONLY=true` and `DIAGNOSTIC_RUN_MIGRATIONS=true`. The serving
pods default to `config.runMigrations: "false"`, so the **runtime database role
needs no DDL grant at all** — only the Job's role does.

Setting `migration.enabled: false` therefore means what it says: nothing in the
release applies DDL. If you disable the Job and still want the pods to migrate
themselves, set `config.runMigrations: "true"` explicitly.

Migrations are expand-only: deploy schema additions, then compatible code, and
remove obsolete columns only after the documented compatibility window.

## Alerting

Webhook alerts need no extra network configuration. SMTP does: the URL and
credentials live in the Secret, which the chart cannot read, so the egress port
has to be declared separately. Set `alerts.smtp.enabled: true` and
`alerts.smtp.port` (587 submission, 465 implicit TLS, 25 relay) alongside
`ALERT_SMTP_URL`. Without it the default NetworkPolicy drops the connection and
every email alert fails silently.

## Rollback and recovery

Use `helm rollback --wait` to restore the previous Deployment. Do not roll back
the database migration: older releases must continue to read expanded schemas.
If processing is unhealthy, set `config.processingEnabled` to `"false"`; upload
receipts and encrypted artifacts remain durable for later processing. Note that
this keeps _accepting_ reports — to stop taking new data (a privacy incident,
say) set `config.ingestEnabled` to `"false"`, which makes grant exchange and
upload answer `503 ingest_disabled` while the read, withdraw and admin routes
stay up so deletion requests can still be served. Restore
PostgreSQL using point-in-time recovery and recover object versions independently.
Validate backups and rollback in every release-candidate environment.
