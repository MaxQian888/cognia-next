# External snapshot adapter protocol

Linux Compose targets that cannot use Kubernetes CSI integrate LVM, ZFS, or a
cloud-volume snapshot tool through one locally configured executable. The
deploy agent invokes that executable as:

```text
/usr/local/libexec/cognia-snapshot-adapter \
  --protocol deploy.cognia.dev/snapshot-adapter/v1alpha1
```

The executable receives exactly one JSON object on stdin and writes exactly
one JSON object to stdout. It must not require secrets in argv. Secrets belong
in root-owned files or the platform secret provider selected during host
enrollment.

Create request:

```json
{
  "apiVersion": "deploy.cognia.dev/snapshot-adapter/v1alpha1",
  "action": "create",
  "adapterRef": "zfs-cognia",
  "backupId": "5d896ba9-6c4c-4dd7-9fc2-f71a7e9972bc",
  "snapshotId": "snapshot-5d896ba9-6c4c-4dd7-9fc2-f71a7e9972bc",
  "projectName": "cognia-production"
}
```

Create response:

```json
{
  "recoveryPoint": {
    "id": "snapshot-5d896ba9-6c4c-4dd7-9fc2-f71a7e9972bc",
    "kind": "snapshot",
    "manifestSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "sizeBytes": 10737418240,
    "verified": true,
    "createdAt": "2026-08-01T10:00:00Z"
  }
}
```

Restore request:

```json
{
  "apiVersion": "deploy.cognia.dev/snapshot-adapter/v1alpha1",
  "action": "restore",
  "adapterRef": "zfs-cognia",
  "snapshotId": "snapshot-5d896ba9-6c4c-4dd7-9fc2-f71a7e9972bc",
  "destinationVolumeName": "cognia-restore-restore-12345678-1234-1234-1234-123456789abc",
  "projectName": "cognia-production"
}
```

The adapter must create an external Docker volume with the exact requested
name, restore the snapshot into it, mount it read-only for its own hash/schema
checks, and return:

```json
{
  "volumeName": "cognia-restore-restore-12345678-1234-1234-1234-123456789abc",
  "verified": true,
  "verification": {
    "hashes": true,
    "schema": true,
    "readOnlySmoke": true
  }
}
```

Unknown response fields, mismatched IDs, mutable/unverified recovery points,
negative sizes, non-SHA-256 manifests, and mismatched destination volumes are
rejected. After a verified response, the agent stops the single writer,
persists a Compose runtime override, activates the new volume, checks
`/readyz`, and automatically restores the previous override if the
readiness check fails.
