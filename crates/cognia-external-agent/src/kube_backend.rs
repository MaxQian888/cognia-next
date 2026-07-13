//! Kubernetes flavor of the container exec backend (ADR-0059 R13, T3).
//!
//! Reuses [`super::container_backend::ContainerBackend`] wholesale — the
//! registry, line-buffering, and event choreography are daemon-agnostic.
//! Only the [`ContainerApi`] seam is reimplemented: one runner **Pod** per
//! spawned agent, the agent binary as the container's only process, stdio
//! over the pod attach API (`Tty: false`), and the workspace mounted as a
//! `subPath` of the shared workspaces **PVC** — a pod never sees another
//! workspace.
//!
//! Differences from the Docker (bollard) flavor, all deliberate:
//! - `pull_image` is a no-op: the kubelet pulls declaratively; a missing
//!   image shows up as the pod never reaching `Running` (timeout below),
//!   never as a create-time 404 — `RunnerRunError::ImageMissing` is unused.
//! - `RunnerSpec.seccomp_json` / `pids_limit` / `network_mode` are ignored:
//!   the k8s answers are a RuntimeClass (gvisor/kata — see
//!   `deploy/k8s/cluster/`), kubelet PID limits, and NetworkPolicy
//!   (`deploy/k8s/base/guardrails.yaml`).
//! - Host binds do not exist: `RunnerMount::Bind` is a hard error;
//!   `COGNIA_WORKSPACES_VOLUME` must name the workspaces PVC.
//! - Attach happens after the pod reports `Running` (k8s cannot attach
//!   pre-start like Docker); an ACP agent only writes after our first
//!   request, so nothing is lost in that window.
//!
//! Layering mirrors `container_backend.rs`: the pod-manifest builder and env
//! parsing below are feature-free and unit-tested here; the kube client
//! implementation lives behind the `k8s-exec` cargo feature so desktop
//! builds never compile a Kubernetes client. In-cluster config only — this
//! backend refuses to boot outside a pod.

#![cfg_attr(not(any(test, feature = "k8s-exec")), allow(dead_code))]

use serde_json::{json, Value};

use super::container_backend::{RunnerMount, RunnerSpec};

// ---------------------------------------------------------------------------
// Environment contract (deploy/k8s/tenant-template is the canonical consumer)
// ---------------------------------------------------------------------------

/// Namespace runner pods are created in (default: the server pod's own
/// namespace via the downward API / in-cluster default).
pub const RUNNER_NAMESPACE_ENV: &str = "COGNIA_RUNNER_NAMESPACE";
/// Node to pin runner pods to (downward API `spec.nodeName`). Required in
/// practice when the workspaces PVC is RWO — runner and server must share
/// the node to share the volume. Leave unset with RWX storage.
pub const RUNNER_NODE_NAME_ENV: &str = "COGNIA_RUNNER_NODE_NAME";
/// Optional runtimeClassName for runner pods (e.g. `gvisor`).
pub const RUNNER_RUNTIME_CLASS_ENV: &str = "COGNIA_RUNNER_RUNTIME_CLASS";
/// Seconds to wait for a runner pod to reach Running (image pull included).
pub const RUNNER_POD_READY_TIMEOUT_ENV: &str = "COGNIA_RUNNER_POD_READY_TIMEOUT_SECS";

const DEFAULT_POD_READY_TIMEOUT_SECS: u64 = 120;
/// The single container's name inside a runner pod (attach targets it).
pub const RUNNER_CONTAINER_NAME: &str = "agent";

#[derive(Clone, Debug)]
pub struct KubeRunnerOptions {
    pub namespace: Option<String>,
    pub node_name: Option<String>,
    pub runtime_class: Option<String>,
    pub pod_ready_timeout_secs: u64,
}

impl KubeRunnerOptions {
    pub fn from_env() -> Result<Self, String> {
        let non_empty = |key: &str| {
            std::env::var(key)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let pod_ready_timeout_secs = match non_empty(RUNNER_POD_READY_TIMEOUT_ENV) {
            Some(v) => v
                .parse()
                .map_err(|e| format!("invalid {RUNNER_POD_READY_TIMEOUT_ENV}: {e}"))?,
            None => DEFAULT_POD_READY_TIMEOUT_SECS,
        };
        Ok(Self {
            namespace: non_empty(RUNNER_NAMESPACE_ENV),
            node_name: non_empty(RUNNER_NODE_NAME_ENV),
            runtime_class: non_empty(RUNNER_RUNTIME_CLASS_ENV),
            pod_ready_timeout_secs,
        })
    }
}

/// DNS-1123 subdomain form of a runner name. `sanitize_container_name`
/// already restricts to `[A-Za-z0-9_.-]`; k8s additionally forbids uppercase
/// and `_`, and requires alphanumeric ends.
pub fn pod_name(spec_name: &str) -> String {
    let lowered: String = spec_name
        .chars()
        .map(|c| match c.to_ascii_lowercase() {
            c if c.is_ascii_alphanumeric() || c == '-' || c == '.' => c,
            _ => '-',
        })
        .collect();
    let trimmed = lowered.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    let mut name = if trimmed.is_empty() {
        "cognia-agent".to_string()
    } else {
        trimmed.to_string()
    };
    name.truncate(63);
    while name
        .chars()
        .last()
        .is_some_and(|c| !c.is_ascii_alphanumeric())
    {
        name.pop();
    }
    name
}

/// Build the runner Pod manifest for `spec`. Pure — unit-tested without a
/// cluster or the kube dependency.
pub fn runner_pod_manifest(spec: &RunnerSpec, opts: &KubeRunnerOptions) -> Result<Value, String> {
    let (claim, sub_path) = match &spec.mount {
        RunnerMount::Volume { volume, subpath } => (volume.clone(), subpath.clone()),
        RunnerMount::Bind { host_dir } => {
            return Err(format!(
                "kubernetes exec mode has no host binds (got {host_dir}) — set \
                 COGNIA_WORKSPACES_VOLUME to the workspaces PVC name"
            ))
        }
    };

    let env: Vec<Value> = spec
        .env
        .iter()
        .map(|kv| {
            let (name, value) = kv.split_once('=').unwrap_or((kv.as_str(), ""));
            json!({ "name": name, "value": value })
        })
        .collect();

    let memory_mi = (spec.memory_bytes / (1024 * 1024)).max(1);
    let milli_cpu = (spec.nano_cpus / 1_000_000).max(1);

    let mut volume_mount = json!({
        "name": "workspace",
        "mountPath": super::container_backend::WORKSPACE_TARGET,
    });
    if let Some(sub) = &sub_path {
        volume_mount["subPath"] = json!(sub);
    }

    let mut pod_spec = json!({
        "restartPolicy": "Never",
        "automountServiceAccountToken": false,
        "containers": [{
            "name": RUNNER_CONTAINER_NAME,
            "image": spec.image,
            "command": spec.cmd,
            "env": env,
            "workingDir": spec.working_dir,
            "stdin": true,
            "stdinOnce": false,
            "tty": false,
            "volumeMounts": [volume_mount],
            "resources": {
                "limits": {
                    "memory": format!("{memory_mi}Mi"),
                    "cpu": format!("{milli_cpu}m"),
                }
            },
            "securityContext": { "allowPrivilegeEscalation": false },
        }],
        "volumes": [{
            "name": "workspace",
            "persistentVolumeClaim": { "claimName": claim },
        }],
    });
    if let Some(node) = &opts.node_name {
        pod_spec["nodeName"] = json!(node);
    }
    if let Some(rc) = &opts.runtime_class {
        pod_spec["runtimeClassName"] = json!(rc);
    }

    Ok(json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": pod_name(&spec.name),
            "labels": { "app": "cognia-runner" },
        },
        "spec": pod_spec,
    }))
}

// ---------------------------------------------------------------------------
// Kube implementation (feature `k8s-exec`)
// ---------------------------------------------------------------------------

#[cfg(feature = "k8s-exec")]
pub mod kube_api {
    use std::sync::Arc;
    use std::time::Duration;

    use async_trait::async_trait;
    use k8s_openapi::api::core::v1::Pod;
    use kube::api::{Api, AttachParams, DeleteParams, PostParams};
    use kube::runtime::wait::{await_condition, conditions};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::mpsc;

    use super::super::container_backend::{
        ContainerApi, RunnerEvent, RunnerRunError, RunnerSpec, RunningRunner,
    };
    use super::{runner_pod_manifest, KubeRunnerOptions, RUNNER_CONTAINER_NAME};

    pub struct KubeContainerApi {
        client: kube::Client,
        namespace: String,
        opts: KubeRunnerOptions,
    }

    impl KubeContainerApi {
        /// In-cluster only: the T3 topology always runs cognia-server as a
        /// pod, and refusing kubeconfig fallbacks keeps the failure mode of
        /// a misconfigured deployment loud.
        pub fn connect() -> Result<Arc<Self>, String> {
            let opts = KubeRunnerOptions::from_env()?;
            let config = kube::Config::incluster()
                .map_err(|e| format!("kubernetes exec mode requires in-cluster config: {e}"))?;
            let namespace = opts
                .namespace
                .clone()
                .unwrap_or_else(|| config.default_namespace.clone());
            let client = kube::Client::try_from(config)
                .map_err(|e| format!("kube client init failed: {e}"))?;
            Ok(Arc::new(Self {
                client,
                namespace,
                opts,
            }))
        }

        fn pods(&self) -> Api<Pod> {
            Api::namespaced(self.client.clone(), &self.namespace)
        }
    }

    /// Exit code of the runner container, if the pod still exists and has
    /// terminated. Best-effort — a killed pod may already be deleted.
    async fn terminated_exit_code(pods: &Api<Pod>, name: &str) -> Option<i64> {
        let pod = pods.get(name).await.ok()?;
        let statuses = pod.status?.container_statuses?;
        let state = statuses.into_iter().next()?.state?;
        state.terminated.map(|t| i64::from(t.exit_code))
    }

    #[async_trait]
    impl ContainerApi for KubeContainerApi {
        async fn run(&self, spec: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
            let manifest =
                runner_pod_manifest(&spec, &self.opts).map_err(RunnerRunError::Other)?;
            let pod: Pod = serde_json::from_value(manifest)
                .map_err(|e| RunnerRunError::Other(format!("pod manifest invalid: {e}")))?;
            let name = pod
                .metadata
                .name
                .clone()
                .expect("runner_pod_manifest always sets a name");
            let pods = self.pods();

            pods.create(&PostParams::default(), &pod)
                .await
                .map_err(|e| RunnerRunError::Other(format!("pod create failed: {e}")))?;

            // Wait for Running (covers scheduling + image pull). On failure,
            // best-effort delete so a wedged pod doesn't leak.
            let running = await_condition(pods.clone(), &name, conditions::is_pod_running());
            let wait = tokio::time::timeout(
                Duration::from_secs(self.opts.pod_ready_timeout_secs),
                running,
            )
            .await;
            let ready = match wait {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(e)) => Err(format!("pod {name} failed while waiting for Running: {e}")),
                Err(_) => Err(format!(
                    "pod {name} not Running within {}s (image pull failure or unschedulable — \
                     kubectl describe pod {name})",
                    self.opts.pod_ready_timeout_secs
                )),
            };
            if let Err(msg) = ready {
                let _ = pods
                    .delete(
                        &name,
                        &DeleteParams {
                            grace_period_seconds: Some(0),
                            ..DeleteParams::default()
                        },
                    )
                    .await;
                return Err(RunnerRunError::Other(msg));
            }

            let attach_params = AttachParams::default()
                .container(RUNNER_CONTAINER_NAME)
                .stdin(true)
                .stdout(true)
                .stderr(true)
                .tty(false);
            let mut attached = pods
                .attach(&name, &attach_params)
                .await
                .map_err(|e| RunnerRunError::Other(format!("pod attach failed: {e}")))?;
            let mut stdin_writer = attached.stdin().ok_or_else(|| {
                RunnerRunError::Other("pod attach returned no stdin stream".into())
            })?;
            let mut stdout_reader = attached.stdout().ok_or_else(|| {
                RunnerRunError::Other("pod attach returned no stdout stream".into())
            })?;
            let mut stderr_reader = attached.stderr().ok_or_else(|| {
                RunnerRunError::Other("pod attach returned no stderr stream".into())
            })?;

            let (event_tx, event_rx) = mpsc::unbounded_channel::<RunnerEvent>();
            let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();

            // stdin pump.
            tokio::spawn(async move {
                while let Some(bytes) = stdin_rx.recv().await {
                    if stdin_writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                    let _ = stdin_writer.flush().await;
                }
            });

            // Output pumps — drain both streams to EOF (the attach streams
            // close when the process exits), THEN resolve the exit code from
            // pod status, so Exited is guaranteed to be the last event.
            let pods_for_status = pods.clone();
            let status_name = name.clone();
            tokio::spawn(async move {
                let out_tx = event_tx.clone();
                let out = async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match stdout_reader.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if out_tx.send(RunnerEvent::Stdout(buf[..n].to_vec())).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                };
                let err_tx = event_tx.clone();
                let err = async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match stderr_reader.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if err_tx.send(RunnerEvent::Stderr(buf[..n].to_vec())).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                };
                tokio::join!(out, err);
                let code = terminated_exit_code(&pods_for_status, &status_name).await;
                let _ = event_tx.send(RunnerEvent::Exited { code });
            });

            Ok(RunningRunner {
                container_id: name,
                events: event_rx,
                stdin: stdin_tx,
            })
        }

        async fn pull_image(&self, _image: &str) -> Result<(), String> {
            // The kubelet pulls declaratively at pod admission; `run` never
            // reports ImageMissing, so this is unreachable in practice.
            Ok(())
        }

        async fn kill(&self, container_id: &str) -> Result<(), String> {
            // grace 0 ≈ SIGKILL: the attach streams close, the reader task
            // emits Exited, and the ContainerBackend choreography proceeds
            // exactly as with the Docker flavor.
            self.pods()
                .delete(
                    container_id,
                    &DeleteParams {
                        grace_period_seconds: Some(0),
                        ..DeleteParams::default()
                    },
                )
                .await
                .map(|_| ())
                .map_err(|e| format!("pod delete failed: {e}"))
        }

        async fn remove(&self, container_id: &str) -> Result<(), String> {
            match self.pods().delete(container_id, &DeleteParams::default()).await {
                Ok(_) => Ok(()),
                // Idempotent: an already-gone pod is success.
                Err(kube::Error::Api(status)) if status.code == 404 => Ok(()),
                Err(e) => Err(format!("pod delete failed: {e}")),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests (feature-free: manifest builder + env parsing)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::super::container_backend::{RunnerMount, RunnerSpec, WORKSPACE_TARGET};
    use super::*;

    fn spec(mount: RunnerMount) -> RunnerSpec {
        RunnerSpec {
            name: "cognia-agent-A_1".into(),
            image: "ghcr.io/example/cognia-runner:test".into(),
            cmd: vec!["claude-code-acp".into(), "--stdio".into()],
            env: vec!["A_KEY=1".into(), "FLAG".into()],
            working_dir: WORKSPACE_TARGET.into(),
            mount,
            seccomp_json: Some("{}".into()),
            memory_bytes: 2048 * 1024 * 1024,
            nano_cpus: 1_500_000_000,
            pids_limit: 512,
            network_mode: "bridge".into(),
        }
    }

    fn opts() -> KubeRunnerOptions {
        KubeRunnerOptions {
            namespace: None,
            node_name: None,
            runtime_class: None,
            pod_ready_timeout_secs: 120,
        }
    }

    #[test]
    fn pod_name_is_dns1123() {
        assert_eq!(pod_name("cognia-agent-A_1"), "cognia-agent-a-1");
        assert_eq!(pod_name("ok.id-9"), "ok.id-9");
        assert_eq!(pod_name("---"), "cognia-agent");
        let long = pod_name(&"x".repeat(80));
        assert_eq!(long.len(), 63);
    }

    #[test]
    fn manifest_maps_spec_onto_a_locked_down_pod() {
        let manifest = runner_pod_manifest(
            &spec(RunnerMount::Volume {
                volume: "cognia-workspaces".into(),
                subpath: Some("ws-1".into()),
            }),
            &KubeRunnerOptions {
                node_name: Some("node-a".into()),
                runtime_class: Some("gvisor".into()),
                ..opts()
            },
        )
        .expect("manifest");

        assert_eq!(manifest["metadata"]["name"], "cognia-agent-a-1");
        let pod_spec = &manifest["spec"];
        assert_eq!(pod_spec["restartPolicy"], "Never");
        assert_eq!(pod_spec["automountServiceAccountToken"], false);
        assert_eq!(pod_spec["nodeName"], "node-a");
        assert_eq!(pod_spec["runtimeClassName"], "gvisor");
        assert_eq!(
            pod_spec["volumes"][0]["persistentVolumeClaim"]["claimName"],
            "cognia-workspaces"
        );

        let container = &pod_spec["containers"][0];
        assert_eq!(container["name"], RUNNER_CONTAINER_NAME);
        assert_eq!(container["command"][0], "claude-code-acp");
        assert_eq!(container["stdin"], true);
        assert_eq!(container["tty"], false);
        assert_eq!(container["workingDir"], WORKSPACE_TARGET);
        assert_eq!(container["volumeMounts"][0]["subPath"], "ws-1");
        assert_eq!(container["resources"]["limits"]["memory"], "2048Mi");
        assert_eq!(container["resources"]["limits"]["cpu"], "1500m");
        assert_eq!(
            container["securityContext"]["allowPrivilegeEscalation"],
            false
        );
        // Env pairs split on the first '='; a bare key becomes an empty value.
        assert_eq!(container["env"][0]["name"], "A_KEY");
        assert_eq!(container["env"][0]["value"], "1");
        assert_eq!(container["env"][1]["name"], "FLAG");
        assert_eq!(container["env"][1]["value"], "");
    }

    #[test]
    fn root_workspace_omits_subpath_and_optional_fields() {
        let manifest = runner_pod_manifest(
            &spec(RunnerMount::Volume {
                volume: "v".into(),
                subpath: None,
            }),
            &opts(),
        )
        .expect("manifest");
        let pod_spec = &manifest["spec"];
        assert!(pod_spec.get("nodeName").is_none());
        assert!(pod_spec.get("runtimeClassName").is_none());
        assert!(pod_spec["containers"][0]["volumeMounts"][0]
            .get("subPath")
            .is_none());
    }

    #[test]
    fn bind_mounts_are_rejected() {
        let err = runner_pod_manifest(
            &spec(RunnerMount::Bind {
                host_dir: "/workspaces/ws-1".into(),
            }),
            &opts(),
        )
        .unwrap_err();
        assert!(err.contains("COGNIA_WORKSPACES_VOLUME"), "{err}");
    }

    #[tokio::test]
    async fn options_from_env_parse_and_default() {
        let _guard = crate::test_env_lock::env_lock().await;
        std::env::remove_var(RUNNER_NAMESPACE_ENV);
        std::env::remove_var(RUNNER_NODE_NAME_ENV);
        std::env::remove_var(RUNNER_RUNTIME_CLASS_ENV);
        std::env::remove_var(RUNNER_POD_READY_TIMEOUT_ENV);
        let defaults = KubeRunnerOptions::from_env().expect("defaults");
        assert_eq!(defaults.namespace, None);
        assert_eq!(defaults.pod_ready_timeout_secs, 120);

        std::env::set_var(RUNNER_NAMESPACE_ENV, "tenant-a");
        std::env::set_var(RUNNER_NODE_NAME_ENV, "node-a");
        std::env::set_var(RUNNER_RUNTIME_CLASS_ENV, "gvisor");
        std::env::set_var(RUNNER_POD_READY_TIMEOUT_ENV, "45");
        let parsed = KubeRunnerOptions::from_env().expect("parsed");
        assert_eq!(parsed.namespace.as_deref(), Some("tenant-a"));
        assert_eq!(parsed.node_name.as_deref(), Some("node-a"));
        assert_eq!(parsed.runtime_class.as_deref(), Some("gvisor"));
        assert_eq!(parsed.pod_ready_timeout_secs, 45);

        std::env::set_var(RUNNER_POD_READY_TIMEOUT_ENV, "not-a-number");
        assert!(KubeRunnerOptions::from_env()
            .unwrap_err()
            .contains(RUNNER_POD_READY_TIMEOUT_ENV));

        std::env::remove_var(RUNNER_NAMESPACE_ENV);
        std::env::remove_var(RUNNER_NODE_NAME_ENV);
        std::env::remove_var(RUNNER_RUNTIME_CLASS_ENV);
        std::env::remove_var(RUNNER_POD_READY_TIMEOUT_ENV);
    }
}
