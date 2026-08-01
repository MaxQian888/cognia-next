# Linux Compose deploy agent

The deploy agent is a locked-down systemd service that opens only an outbound
mTLS WebSocket to the Ops Controller. It does not expose SSH, an HTTP admin
port, or an arbitrary command surface.

1. Build `cognia-deploy-agent` from the tagged source revision and install it
   as `/usr/local/bin/cognia-deploy-agent`.
2. Create the system user and owner-only directories:

   ```sh
   sudo useradd --system --home /var/lib/cognia-agent --shell /usr/sbin/nologin cognia-agent
   sudo install -d -o cognia-agent -g cognia-agent -m 0700 \
     /var/lib/cognia-agent/credentials /var/lib/cognia-agent/state
   sudo install -d -o root -g cognia-agent -m 0750 /etc/cognia
   ```

3. Request an enrollment token from `POST /v1/agents/enrollment-tokens`, write
   it to an owner-only file, then enroll without exposing it in argv:

   ```sh
   sudo install -o cognia-agent -g cognia-agent -m 0600 enrollment-token \
     /var/lib/cognia-agent/enrollment-token
   sudo -u cognia-agent cognia-deploy-agent enroll \
     --controller-url https://ops.example.com \
     --token-file /var/lib/cognia-agent/enrollment-token \
     --agent-id staging-agent \
     --output-directory /var/lib/cognia-agent/credentials
   sudo rm /var/lib/cognia-agent/enrollment-token
   ```

4. Copy `deploy-agent.example.yaml` to `/etc/cognia/deploy-agent.yaml` and
   replace the enrollment fields from `enrollment.json`. Install
   `cognia-deploy-agent.service`, run `systemd-analyze verify` on it, then
   enable and start the service.

For production certification, install the configured `snapshotAdapter.binary`
as a root-owned executable. The Agent invokes it only with the versioned JSON
protocol on stdin; requests cannot provide shell, argv, executable, or host
paths. Remove `snapshotAdapter` only for non-certified object-backup-only
deployments.

The service account needs permission to invoke `docker compose` for only the
configured deployment root. On hosts where Docker access implies root, run a
rootless Docker daemon for `cognia-agent`; do not add the agent to a shared
rootful `docker` group.
