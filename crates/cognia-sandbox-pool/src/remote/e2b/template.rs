//! E2B templates: the user's image with the agent bundle injected (ADR-0221
//! D4).
//!
//! One template per (user image digest, bundle digest, size class), because
//! E2B sizes a sandbox by its template. The name is derived from those three,
//! so every Host sharing an E2B team finds and reuses a ready template instead
//! of building its own. A build (Build System 2.0) is:
//!
//! 1. `fromImage` the digest-pinned user image, with pull credentials only
//!    when the driver handed them over (delegated registries, G12);
//! 2. `COPY` the bundle's flattened `opt/cognia` tree to `/opt/cognia`,
//!    uploaded once per bundle digest into E2B's content-addressed file cache;
//! 3. the three `cognia-sandboxd install` stages into `/cognia` — core, then
//!    both libc trees, which coexist by their stage markers;
//! 4. an empty, world-writable `/workspace`.
//!
//! Every step runs as root: E2B's default build user is not, and the bundle
//! and the workspace are root-owned in every other driver too.

use std::time::Duration;

use cognia_environment::catalog::SizeClass;
use cognia_environment::image::PinnedImage;
use cognia_external_agent::container_backend::RegistryAuth;
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
use cognia_sandboxd::layout::{BIN_DIR, BUNDLE_ROOT, INJECTION_ROOT, WORKSPACE_ROOT};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use super::api::{AliasLookup, ApiClient, ApiError, BuildInfo};
use super::bundle::{prepare_rootfs, BundleSource, BUNDLE_TREE};
use crate::remote::START_MARKER;

/// The longest size-class part of a template name.
const SIZE_PART_MAX: usize = 40;
/// E2B's smallest sandbox memory.
const MIN_MEMORY_MB: u32 = 128;
/// Consecutive failed status polls tolerated before a build is given up on.
const MAX_POLL_FAILURES: u32 = 5;
/// Status calls made to drain the logs of a finished build.
const MAX_LOG_DRAIN_CALLS: usize = 50;
/// Hashed with the bundle digest into the COPY step's files hash. Bump it
/// whenever the archive's shape changes, so no cache serves the old shape.
const ARCHIVE_FORMAT: &str = "cognia-bundle-rootfs:v1:";

/// Everything one template build needs, derived from a provision request.
#[derive(Clone)]
pub(super) struct TemplatePlan {
    pub name: String,
    pub from_image: String,
    /// `fromImageRegistry` (`{type: "registry", username, password}`).
    pub registry: Option<Value>,
    pub cpu_count: u32,
    pub memory_mb: u32,
    pub bundle: BundleSource,
}

impl std::fmt::Debug for TemplatePlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TemplatePlan")
            .field("name", &self.name)
            .field("from_image", &self.from_image)
            .field("registry", &self.registry.as_ref().map(|_| "<credentials>"))
            .field("cpu_count", &self.cpu_count)
            .field("memory_mb", &self.memory_mb)
            .field("bundle", &self.bundle.image.canonical())
            .finish()
    }
}

/// The first twelve hex digits of a `sha256:` digest.
fn digest12(digest: &str) -> &str {
    let hex = digest.strip_prefix("sha256:").unwrap_or(digest);
    &hex[..hex.len().min(12)]
}

/// A size class id as an E2B identifier part (`[a-z0-9_-]`).
fn size_part(id: &str) -> String {
    let mapped: String = id
        .chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = mapped.trim_matches('-');
    let capped: String = trimmed.chars().take(SIZE_PART_MAX).collect();
    let capped = capped.trim_end_matches('-').to_string();
    if capped.is_empty() {
        "size".to_string()
    } else {
        capped
    }
}

/// `<prefix>-<digest12(image)>-<digest12(bundle)>-<size>`: deterministic, so
/// a second Host reuses the first Host's template.
pub(super) fn template_name(
    prefix: &str,
    image: &PinnedImage,
    bundle: &PinnedImage,
    size: &SizeClass,
) -> String {
    format!(
        "{prefix}-{}-{}-{}",
        digest12(&image.digest),
        digest12(&bundle.digest),
        size_part(&size.id)
    )
}

/// The files hash the bundle archive is cached under in E2B.
pub(super) fn bundle_files_hash(bundle: &PinnedImage) -> String {
    hex::encode(Sha256::digest(
        format!("{ARCHIVE_FORMAT}{}", bundle.digest).as_bytes(),
    ))
}

/// Whole CPUs (at least one) and MiB (at least E2B's floor) for a size class.
pub(super) fn resources(size: &SizeClass) -> (u32, u32) {
    let cpus = size.cpu_millis.div_ceil(1000).max(1);
    let memory = size.memory_mib.max(MIN_MEMORY_MB);
    (cpus, memory)
}

/// `fromImageRegistry` for the driver's credentials. E2B's generic registry
/// type takes a username and password only; a token cannot be handed over.
pub(super) fn from_image_registry(
    auth: Option<&RegistryAuth>,
) -> Result<Option<Value>, SandboxSpawnError> {
    let Some(auth) = auth else {
        return Ok(None);
    };
    let username = auth.username.as_deref().filter(|value| !value.is_empty());
    let password = auth.password.as_deref().filter(|value| !value.is_empty());
    match (username, password) {
        (Some(username), Some(password)) => Ok(Some(json!({
            "type": "registry",
            "username": username,
            "password": password,
        }))),
        _ => Err(SandboxSpawnError::refused(
            "sandbox_registry_auth_unsupported",
            format!(
                "E2B pulls {} only with a username and password; the credential configured for it is a token",
                auth.server_address
            ),
        )),
    }
}

/// The build steps after `fromImage`.
pub(super) fn build_steps(files_hash: &str) -> Vec<Value> {
    let install = |stage: &str| {
        format!("{BUNDLE_ROOT}/{BIN_DIR}/cognia-sandboxd install {stage} --from {BUNDLE_ROOT} --to {INJECTION_ROOT}")
    };
    let control_dir = std::path::Path::new(START_MARKER)
        .parent()
        .and_then(|dir| dir.to_str())
        .expect("the start marker lives in a directory");
    let run = |command: String| json!({ "type": "RUN", "args": [command, "root"], "force": false });
    vec![
        json!({
            "type": "COPY",
            "args": [BUNDLE_TREE, BUNDLE_ROOT, "root", ""],
            "filesHash": files_hash,
            "force": false,
        }),
        run(install("--stage core")),
        run(install("--stage libc --libc glibc")),
        run(install("--stage libc --libc musl")),
        run(format!(
            "rm -rf {WORKSPACE_ROOT} && mkdir -p {WORKSPACE_ROOT} {control_dir} && chmod 0777 {WORKSPACE_ROOT}"
        )),
    ]
}

/// The `TemplateBuildStartV2` body.
pub(super) fn build_body(plan: &TemplatePlan) -> Value {
    let mut body = json!({
        "fromImage": plan.from_image,
        "force": false,
        "steps": build_steps(&bundle_files_hash(&plan.bundle.image)),
    });
    if let Some(registry) = &plan.registry {
        body["fromImageRegistry"] = registry.clone();
    }
    body
}

fn timeout_error(plan: &TemplatePlan, timeout: Duration) -> SandboxSpawnError {
    SandboxSpawnError::fault(
        "sandbox_template_build_timeout",
        format!(
            "the E2B template {} was not ready within {}s",
            plan.name,
            timeout.as_secs()
        ),
    )
}

/// The line a failed build is reported with: its last error-level log line,
/// else the status reason, else its last log line.
fn failure_line(info: &BuildInfo, last_error: Option<&str>, last_line: Option<&str>) -> String {
    let reason = info
        .reason
        .as_ref()
        .map(|reason| reason.message.trim())
        .filter(|message| !message.is_empty());
    let reason_error = info.reason.as_ref().and_then(|reason| {
        reason
            .log_entries
            .iter()
            .rev()
            .find(|entry| entry.level == "error" && !entry.message.trim().is_empty())
            .map(|entry| entry.message.trim())
    });
    reason_error
        .or(last_error)
        .or(reason)
        .or(last_line)
        .unwrap_or("the template build failed")
        .to_string()
}

/// How waiting for one build ended.
enum BuildEnd {
    Ready,
    Failed(String),
}

/// Polls a build until it is ready or failed, reading its logs along the
/// way. Transient poll failures are retried a few times in a row.
async fn wait_build(
    api: &ApiClient,
    template_id: &str,
    build_id: &str,
    poll: Duration,
) -> Result<BuildEnd, ApiError> {
    let mut offset = 0usize;
    let mut last_error: Option<String> = None;
    let mut last_line: Option<String> = None;
    let mut failures = 0u32;
    let mut absorb = |info: &BuildInfo, offset: &mut usize| {
        *offset += info.log_entries.len();
        for entry in &info.log_entries {
            let message = entry.message.trim();
            if message.is_empty() {
                continue;
            }
            if entry.level == "error" {
                last_error = Some(message.to_string());
            }
            last_line = Some(message.to_string());
        }
    };
    loop {
        let info = match api.build_status(template_id, build_id, offset).await {
            Ok(info) => {
                failures = 0;
                info
            }
            Err(error) if error.is_transient() && failures + 1 < MAX_POLL_FAILURES => {
                failures += 1;
                tokio::time::sleep(poll).await;
                continue;
            }
            Err(error) => return Err(error),
        };
        absorb(&info, &mut offset);
        match info.status.as_str() {
            "ready" => return Ok(BuildEnd::Ready),
            "error" => {
                // The status call returns at most 100 log lines; drain the
                // rest for the line that says what failed.
                let mut drained = info.log_entries.len();
                let mut calls = 0;
                while drained > 0 && calls < MAX_LOG_DRAIN_CALLS {
                    calls += 1;
                    match api.build_status(template_id, build_id, offset).await {
                        Ok(more) => {
                            drained = more.log_entries.len();
                            absorb(&more, &mut offset);
                        }
                        Err(_) => break,
                    }
                }
                return Ok(BuildEnd::Failed(failure_line(
                    &info,
                    last_error.as_deref(),
                    last_line.as_deref(),
                )));
            }
            "building" | "waiting" => tokio::time::sleep(poll).await,
            other => {
                return Err(ApiError::Invalid(format!(
                    "build {build_id} is in an unknown state {other:?}"
                )))
            }
        }
    }
}

/// Returns the id of a ready template for `plan`, building it when no Host
/// has. Callers serialize concurrent calls for one plan name.
pub(super) async fn ensure_template(
    api: &ApiClient,
    plan: &TemplatePlan,
    poll: Duration,
    timeout: Duration,
) -> Result<String, SandboxSpawnError> {
    let deadline = Instant::now() + timeout;
    let lookup = api
        .template_by_alias(&plan.name)
        .await
        .map_err(|error| error.to_spawn_error("looking up the E2B template"))?;
    if let AliasLookup::Owned { template_id } = lookup {
        let builds = api
            .template_builds(&template_id)
            .await
            .map_err(|error| error.to_spawn_error("listing the E2B template's builds"))?;
        if builds.iter().any(|build| build.status == "ready") {
            return Ok(template_id);
        }
        // Another Host may be building it right now: share that build.
        if let Some(running) = builds
            .iter()
            .find(|build| build.status == "building" || build.status == "waiting")
        {
            let waited = tokio::time::timeout_at(
                deadline,
                wait_build(api, &template_id, &running.build_id, poll),
            )
            .await
            .map_err(|_| timeout_error(plan, timeout))?
            .map_err(|error| error.to_spawn_error("waiting for the E2B template build"))?;
            match waited {
                BuildEnd::Ready => return Ok(template_id),
                BuildEnd::Failed(line) => {
                    log::warn!(
                        "e2b: another build of template {} failed ({line}); building it again",
                        plan.name
                    );
                }
            }
        }
    }

    match tokio::time::timeout_at(deadline, build(api, plan, poll)).await {
        Ok(result) => result,
        Err(_) => Err(timeout_error(plan, timeout)),
    }
}

async fn build(
    api: &ApiClient,
    plan: &TemplatePlan,
    poll: Duration,
) -> Result<String, SandboxSpawnError> {
    let requested = api
        .request_build(&plan.name, plan.cpu_count, plan.memory_mb)
        .await
        .map_err(|error| error.to_spawn_error("requesting the E2B template build"))?;
    let files_hash = bundle_files_hash(&plan.bundle.image);
    let upload = api
        .file_upload(&requested.template_id, &files_hash)
        .await
        .map_err(|error| error.to_spawn_error("asking E2B for the bundle upload link"))?;
    if !upload.present {
        let url = upload.url.as_deref().ok_or_else(|| {
            SandboxSpawnError::fault(
                "sandbox_provider_unreachable",
                "E2B asked for the bundle but gave no upload link",
            )
        })?;
        let archive = prepare_rootfs(&plan.bundle)
            .await
            .map_err(|error| error.into_spawn_error(&plan.bundle.image))?;
        api.upload(
            url,
            &upload.headers.clone().unwrap_or_default(),
            &archive.path,
            archive.size,
        )
        .await
        .map_err(|error| error.to_spawn_error("uploading the agent bundle to E2B"))?;
        log::info!(
            "e2b: uploaded the agent bundle {} ({} bytes) for template {}",
            plan.bundle.image.canonical(),
            archive.size,
            plan.name
        );
    }
    api.start_build(
        &requested.template_id,
        &requested.build_id,
        &build_body(plan),
    )
    .await
    .map_err(|error| match error.status() {
        // The build request itself was refused: the image or a step.
        Some(400) => SandboxSpawnError::refused(
            "sandbox_template_build_failed",
            format!("E2B refused to build template {}: {error}", plan.name),
        ),
        _ => error.to_spawn_error("starting the E2B template build"),
    })?;
    match wait_build(api, &requested.template_id, &requested.build_id, poll)
        .await
        .map_err(|error| error.to_spawn_error("waiting for the E2B template build"))?
    {
        BuildEnd::Ready => Ok(requested.template_id),
        BuildEnd::Failed(line) => Err(SandboxSpawnError::refused(
            "sandbox_template_build_failed",
            line,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_server::{FakeE2b, FakeRegistry, TarEntry};
    use super::*;
    use cognia_external_agent::sandbox_routing_backend::SandboxErrorKind;

    fn pinned(registry: &str, repository: &str, fill: char) -> PinnedImage {
        PinnedImage {
            registry: registry.into(),
            repository: repository.into(),
            digest: format!("sha256:{}", fill.to_string().repeat(64)),
        }
    }

    fn size(id: &str, cpu_millis: u32, memory_mib: u32) -> SizeClass {
        SizeClass {
            id: id.into(),
            label: id.into(),
            cpu_millis,
            memory_mib,
            ephemeral_storage_mib: 10_240,
            volume_mib: 10_240,
            gpu: None,
        }
    }

    #[test]
    fn names_are_deterministic_identifiers() {
        let image = pinned("docker.io", "library/node", 'a');
        let bundle = pinned("ghcr.io", "cognia/agent-bundle", 'b');
        let name = template_name(
            "cognia",
            &image,
            &bundle,
            &size("Medium (4 vCPU)", 4000, 8192),
        );
        assert_eq!(name, "cognia-aaaaaaaaaaaa-bbbbbbbbbbbb-medium--4-vcpu");
        assert!(name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'));
        assert_eq!(
            template_name("cognia", &image, &bundle, &size("???", 1, 1)),
            "cognia-aaaaaaaaaaaa-bbbbbbbbbbbb-size"
        );
        let long = template_name("cognia", &image, &bundle, &size(&"x".repeat(200), 1, 1));
        assert!(long.len() <= 128, "{}", long.len());
        assert_ne!(
            bundle_files_hash(&bundle),
            bundle_files_hash(&pinned("ghcr.io", "cognia/agent-bundle", 'c'))
        );
        assert_eq!(bundle_files_hash(&bundle).len(), 64);
    }

    #[test]
    fn sizes_round_up_to_what_e2b_offers() {
        assert_eq!(resources(&size("s", 500, 64)), (1, 128));
        assert_eq!(resources(&size("m", 2000, 4096)), (2, 4096));
        assert_eq!(resources(&size("l", 2500, 6000)), (3, 6000));
        assert_eq!(resources(&size("z", 0, 0)), (1, 128));
    }

    #[test]
    fn only_password_credentials_are_handed_to_e2b() {
        assert_eq!(from_image_registry(None).unwrap(), None);
        let basic = RegistryAuth {
            server_address: "ghcr.io".into(),
            username: Some("bot".into()),
            password: Some("pw".into()),
            ..RegistryAuth::default()
        };
        assert_eq!(
            from_image_registry(Some(&basic)).unwrap(),
            Some(json!({ "type": "registry", "username": "bot", "password": "pw" }))
        );
        let token = RegistryAuth {
            server_address: "ghcr.io".into(),
            registry_token: Some("tok-secret-xyz".into()),
            ..RegistryAuth::default()
        };
        let error = from_image_registry(Some(&token)).unwrap_err();
        assert_eq!(error.code, "sandbox_registry_auth_unsupported");
        assert_eq!(error.kind, SandboxErrorKind::Refused);
        assert!(!error.message.contains("tok-secret-xyz"));
        let half = RegistryAuth {
            server_address: "ghcr.io".into(),
            username: Some("bot".into()),
            ..RegistryAuth::default()
        };
        assert!(from_image_registry(Some(&half)).is_err());
    }

    #[test]
    fn steps_copy_the_bundle_and_install_every_stage_as_root() {
        let steps = build_steps("hash");
        assert_eq!(
            steps[0],
            json!({
                "type": "COPY",
                "args": ["opt/cognia", "/opt/cognia", "root", ""],
                "filesHash": "hash",
                "force": false,
            })
        );
        let commands: Vec<&str> = steps[1..]
            .iter()
            .map(|step| {
                assert_eq!(step["type"], "RUN");
                assert_eq!(step["args"][1], "root");
                step["args"][0].as_str().unwrap()
            })
            .collect();
        assert_eq!(
            commands,
            vec![
                "/opt/cognia/bin/cognia-sandboxd install --stage core --from /opt/cognia --to /cognia",
                "/opt/cognia/bin/cognia-sandboxd install --stage libc --libc glibc --from /opt/cognia --to /cognia",
                "/opt/cognia/bin/cognia-sandboxd install --stage libc --libc musl --from /opt/cognia --to /cognia",
                "rm -rf /workspace && mkdir -p /workspace /tmp/cognia-sandboxd && chmod 0777 /workspace",
            ]
        );
    }

    #[test]
    fn a_failed_build_reports_its_last_error_line() {
        let info = |reason: Option<&str>, reason_logs: &[(&str, &str)]| BuildInfo {
            status: "error".into(),
            log_entries: Vec::new(),
            reason: reason.map(|message| super::super::api::BuildStatusReason {
                message: message.into(),
                log_entries: reason_logs
                    .iter()
                    .map(|(level, message)| super::super::api::BuildLogEntry {
                        level: (*level).into(),
                        message: (*message).into(),
                    })
                    .collect(),
            }),
        };
        assert_eq!(
            failure_line(
                &info(
                    Some("step 2 failed"),
                    &[("info", "x"), ("error", "glibc too old")]
                ),
                Some("earlier"),
                None
            ),
            "glibc too old"
        );
        assert_eq!(
            failure_line(&info(Some("step 2 failed"), &[]), Some("exit 1"), Some("x")),
            "exit 1"
        );
        assert_eq!(
            failure_line(&info(Some("step 2 failed"), &[]), None, Some("x")),
            "step 2 failed"
        );
        assert_eq!(failure_line(&info(None, &[]), None, Some("last")), "last");
        assert_eq!(
            failure_line(&info(None, &[]), None, None),
            "the template build failed"
        );
    }

    async fn plan_for(registry: &FakeRegistry, name: &str) -> TemplatePlan {
        TemplatePlan {
            name: name.into(),
            from_image: "docker.io/library/node@sha256:".to_string() + &"a".repeat(64),
            registry: None,
            cpu_count: 2,
            memory_mb: 2048,
            bundle: BundleSource {
                image: registry.image.clone(),
                auth: Some(RegistryAuth {
                    server_address: registry.image.registry.clone(),
                    username: Some(FakeRegistry::USER.into()),
                    password: Some(FakeRegistry::PASSWORD.into()),
                    ..RegistryAuth::default()
                }),
                insecure: true,
            },
        }
    }

    #[tokio::test]
    async fn a_missing_template_is_built_with_the_bundle_uploaded_once() {
        let fake = FakeE2b::start().await;
        let registry = FakeRegistry::start_bundle(&[TarEntry::file(
            "opt/cognia/bin/cognia-sandboxd",
            b"sbx",
            0o755,
        )])
        .await;
        let plan = plan_for(&registry, "cognia-t1").await;
        fake.script_build_statuses(&["building", "ready"]);
        let id = ensure_template(
            &fake.api(),
            &plan,
            Duration::from_millis(5),
            Duration::from_secs(30),
        )
        .await
        .unwrap();
        assert_eq!(fake.template_id("cognia-t1").as_deref(), Some(id.as_str()));
        let request = fake.last_request("/v3/templates");
        assert_eq!(
            request.json(),
            json!({ "name": "cognia-t1", "cpuCount": 2, "memoryMB": 2048 })
        );
        let hash = bundle_files_hash(&registry.image);
        let upload = fake.last_request(&format!("/upload/{hash}"));
        assert_eq!(upload.header("x-amz-meta-cognia"), Some("1"));
        assert_eq!(
            upload.header("content-length").unwrap(),
            upload.body.len().to_string()
        );
        let start = fake
            .requests()
            .into_iter()
            .find(|request| request.method == "POST" && request.path.starts_with("/v2/templates/"))
            .unwrap();
        let body = start.json();
        assert_eq!(body["fromImage"], plan.from_image);
        assert!(body.get("fromImageRegistry").is_none());
        assert_eq!(body["steps"][0]["filesHash"], hash);

        // A second template of the same bundle finds the archive cached.
        let uploads_before = fake.requests_to(&format!("/upload/{hash}")).len();
        let second = plan_for(&registry, "cognia-t2").await;
        ensure_template(
            &fake.api(),
            &second,
            Duration::from_millis(5),
            Duration::from_secs(30),
        )
        .await
        .unwrap();
        assert_eq!(
            fake.requests_to(&format!("/upload/{hash}")).len(),
            uploads_before
        );

        // And the first template, now ready, is reused without a build.
        let builds_before = fake.requests_to("/v3/templates").len();
        let again = ensure_template(
            &fake.api(),
            &plan,
            Duration::from_millis(5),
            Duration::from_secs(30),
        )
        .await
        .unwrap();
        assert_eq!(again, id);
        assert_eq!(fake.requests_to("/v3/templates").len(), builds_before);
    }

    #[tokio::test]
    async fn another_hosts_build_in_flight_is_waited_for() {
        let fake = FakeE2b::start().await;
        let registry = FakeRegistry::start_bundle(&[TarEntry::file(
            "opt/cognia/bin/cognia-sandboxd",
            b"sbx",
            0o755,
        )])
        .await;
        let template = fake.add_template("cognia-shared", &[("b1", "building")]);
        fake.script_build_statuses(&["building", "ready"]);
        let plan = plan_for(&registry, "cognia-shared").await;
        let id = ensure_template(
            &fake.api(),
            &plan,
            Duration::from_millis(5),
            Duration::from_secs(30),
        )
        .await
        .unwrap();
        assert_eq!(id, template);
        assert!(
            fake.requests_to("/v3/templates").is_empty(),
            "no second build"
        );
    }

    #[tokio::test]
    async fn failures_and_timeouts_map_to_their_codes() {
        let fake = FakeE2b::start().await;
        let registry = FakeRegistry::start_bundle(&[TarEntry::file(
            "opt/cognia/bin/cognia-sandboxd",
            b"sbx",
            0o755,
        )])
        .await;
        fake.script_build_failure(
            "step 3 failed",
            &[
                ("info", "installing"),
                ("error", "probe_glibc_too_old: glibc 2.17"),
            ],
        );
        let plan = plan_for(&registry, "cognia-fails").await;
        let error = ensure_template(
            &fake.api(),
            &plan,
            Duration::from_millis(5),
            Duration::from_secs(30),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "sandbox_template_build_failed");
        assert_eq!(error.kind, SandboxErrorKind::Refused);
        assert_eq!(error.message, "probe_glibc_too_old: glibc 2.17");

        fake.script_build_statuses(&["building"; 1000]);
        let slow = plan_for(&registry, "cognia-slow").await;
        let error = ensure_template(
            &fake.api(),
            &slow,
            Duration::from_millis(20),
            Duration::from_millis(150),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "sandbox_template_build_timeout");
        assert_eq!(error.kind, SandboxErrorKind::Fault);

        fake.fail_next("/templates/aliases/cognia-denied", 401, "bad key");
        let denied = plan_for(&registry, "cognia-denied").await;
        let error = ensure_template(
            &fake.api(),
            &denied,
            Duration::from_millis(5),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "sandbox_provider_unauthorized");
    }
}
