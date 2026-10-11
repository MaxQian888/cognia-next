//! The host updater against a fake Worker, a real install home and signed
//! catalogs built with the conformance fixture's keys.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cognia_host_service::install_home::{InstallHome, UpdateResult};
use cognia_host_service::test_support::{write_archive, write_install};
use cognia_update_catalog::test_support::{host_release_entries, root, sign_bundle};
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::idle::{IdleProbe, IdleReport};
use super::network::{RolloutAnswer, RolloutQuery, UpdateNetwork};
use super::updater::{
    DetectInput, HostInstall, HostUpdater, HostUpdaterDeps, InstallKind, TrialHealth, TrialSignal,
    UnmanagedReason, UpdatePhase, WriteGate,
};

const TARGET: &str = "darwin-arm64";
const BASE_MS: i64 = 1_760_000_000_000;

#[derive(Default)]
struct FakeNetwork {
    catalog: Mutex<Option<Value>>,
    rollout: Mutex<Option<RolloutAnswer>>,
    archive: Mutex<Option<PathBuf>>,
    rollout_queries: Mutex<Vec<RolloutQuery>>,
    downloads: AtomicUsize,
}

#[async_trait]
impl UpdateNetwork for FakeNetwork {
    async fn catalog(&self, _channel: &str) -> Result<Option<Value>, String> {
        Ok(self.catalog.lock().clone())
    }

    async fn rollout(&self, query: &RolloutQuery) -> Result<Option<RolloutAnswer>, String> {
        self.rollout_queries.lock().push(query.clone());
        Ok(self.rollout.lock().clone())
    }

    async fn download(&self, _url: &str, destination: &Path, _max: u64) -> Result<(), String> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        let source = self.archive.lock().clone().ok_or("no archive")?;
        std::fs::copy(source, destination)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

/// Reports in order, repeating the last one.
struct FakeIdle(Mutex<Vec<IdleReport>>);

impl FakeIdle {
    fn set(&self, reports: Vec<IdleReport>) {
        *self.0.lock() = reports;
    }
}

impl IdleProbe for FakeIdle {
    fn report(&self, _now_ms: i64) -> IdleReport {
        let mut reports = self.0.lock();
        if reports.len() > 1 {
            reports.remove(0)
        } else {
            reports[0].clone()
        }
    }
}

#[derive(Default)]
struct FakeWrites(AtomicUsize);

#[async_trait]
impl WriteGate for FakeWrites {
    async fn pause(&self) -> Result<Box<dyn std::any::Any + Send>, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(()))
    }
}

struct FixedHealth(TrialSignal);

impl TrialHealth for FixedHealth {
    fn signal(&self) -> TrialSignal {
        self.0.clone()
    }
}

fn quiet() -> IdleReport {
    IdleReport {
        active_runs: Some(0),
        ..IdleReport::default()
    }
}

struct Harness {
    _tmp: tempfile::TempDir,
    home: InstallHome,
    network: Arc<FakeNetwork>,
    idle: Arc<FakeIdle>,
    writes: Arc<FakeWrites>,
    restarts: Arc<AtomicUsize>,
    updater: Arc<HostUpdater>,
    archive_sha: String,
}

/// A native host on 1.4.0, a signed 1.5.0 release, and a Worker rolling it.
fn harness() -> Harness {
    harness_with(|home| InstallKind::Native(home.clone()), true)
}

fn harness_with(kind: impl FnOnce(&InstallHome) -> InstallKind, trust: bool) -> Harness {
    let tmp = tempfile::tempdir().unwrap();
    let unpacked = tmp.path().join("unpacked");
    write_install(&unpacked, "1.4.0", TARGET);
    let data = tmp.path().join("data");
    let home = InstallHome::in_data_dir(&data);
    home.adopt(&unpacked).unwrap();
    let (archive, archive_sha) = write_archive(tmp.path(), "1.5.0", TARGET, |_| {});

    let network = Arc::new(FakeNetwork::default());
    *network.catalog.lock() = Some(sign_bundle(
        host_release_entries(
            "1.5.0",
            "stable",
            TARGET,
            json!({ "url": "https://example.test/host.tar.gz", "sha256": archive_sha }),
        ),
        1,
        chrono::DateTime::from_timestamp_millis(BASE_MS).unwrap(),
    ));
    *network.rollout.lock() = Some(RolloutAnswer {
        version: "1.5.0".into(),
        digest: Some(archive_sha.clone()),
    });
    *network.archive.lock() = Some(archive);
    let idle = Arc::new(FakeIdle(Mutex::new(vec![quiet()])));
    let writes = Arc::new(FakeWrites::default());
    let restarts = Arc::new(AtomicUsize::new(0));
    let start = tokio::time::Instant::now();
    let restart_count = Arc::clone(&restarts);
    let updater = HostUpdater::new(
        &data,
        HostInstall {
            kind: kind(&home),
            version: "1.4.0".into(),
            target: Some(TARGET.into()),
        },
        trust.then(root),
        HostUpdaterDeps {
            network: network.clone(),
            idle: idle.clone(),
            writes: writes.clone(),
            restart: Arc::new(move || {
                restart_count.fetch_add(1, Ordering::SeqCst);
            }),
            clock: Arc::new(move || BASE_MS + start.elapsed().as_millis() as i64),
        },
    );
    Harness {
        _tmp: tmp,
        home,
        network,
        idle,
        writes,
        restarts,
        updater,
        archive_sha,
    }
}

#[tokio::test]
async fn offers_a_release_the_catalog_signs_and_the_worker_rolls() {
    let h = harness();
    let status = h.updater.check(false).await.unwrap();
    assert_eq!(status.available.unwrap().version, "1.5.0");
    assert_eq!(status.phase, UpdatePhase::Available);
    assert_eq!(status.install, "native");
    assert!(status.last_checked_at.is_some());
    let query = h.network.rollout_queries.lock()[0].clone();
    assert_eq!(
        (
            query.target.as_str(),
            query.current_version.as_str(),
            query.manual
        ),
        (TARGET, "1.4.0", false)
    );
}

#[tokio::test]
async fn the_worker_can_hold_a_release_back_but_never_substitute_one() {
    let h = harness();
    for answer in [
        None,
        Some(RolloutAnswer {
            version: "1.5.0".into(),
            digest: Some("0".repeat(64)),
        }),
        Some(RolloutAnswer {
            version: "1.6.0".into(),
            digest: Some(h.archive_sha.clone()),
        }),
    ] {
        *h.network.rollout.lock() = answer;
        let status = h.updater.check(false).await.unwrap();
        assert!(status.available.is_none());
        assert_eq!(status.phase, UpdatePhase::Idle);
    }
}

#[tokio::test]
async fn an_unverifiable_catalog_is_an_error_never_an_update() {
    let h = harness();
    h.network.catalog.lock().as_mut().unwrap()["targets"]["signed"]["entries"][0]["url"] =
        json!("https://elsewhere.test/host.tar.gz");
    let error = h.updater.check(false).await.unwrap_err();
    assert!(error.contains("targets"), "{error}");
    let status = h.updater.status();
    assert!(status.available.is_none());
    assert_eq!(status.last_error.as_deref(), Some(error.as_str()));

    let untrusting = harness_with(|home| InstallKind::Native(home.clone()), false);
    assert!(untrusting
        .updater
        .check(false)
        .await
        .unwrap_err()
        .contains("trust root"));
}

#[tokio::test]
async fn a_new_channel_drops_what_the_old_one_offered() {
    let h = harness();
    h.updater.check(false).await.unwrap();
    assert!(h
        .updater
        .configure(Some("nightly"), None, None)
        .unwrap_err()
        .contains("not a release channel"));
    let status = h
        .updater
        .configure(Some("beta"), Some(false), Some("owner-phone"))
        .unwrap();
    assert_eq!(status.channel, "beta");
    assert!(!status.auto_update);
    assert_eq!(status.channel_set_by.as_deref(), Some("owner-phone"));
    assert!(status.available.is_none());
    // Settings outlive the process.
    assert_eq!(h.updater.settings().channel, "beta");
}

#[tokio::test(start_paused = true)]
async fn an_update_waits_for_idle_then_swaps_and_restarts() {
    let h = harness();
    h.idle.set(vec![IdleReport {
        active_runs: Some(2),
        jobs: 1,
        ..IdleReport::default()
    }]);
    let status = h.updater.request_install().await.unwrap();
    assert!(status.install_requested);
    h.updater.tick().await;
    let status = h.updater.status();
    assert_eq!(status.phase, UpdatePhase::WaitingForIdle);
    assert_eq!(status.waiting_for.unwrap().active_runs, Some(2));
    assert_eq!(h.restarts.load(Ordering::SeqCst), 0);
    assert_eq!(h.home.current_version().as_deref(), Some("1.4.0"));

    h.idle.set(vec![quiet()]);
    h.updater.tick().await;
    assert_eq!(h.updater.status().last_error, None);
    assert_eq!(h.network.downloads.load(Ordering::SeqCst), 1);
    assert_eq!(h.writes.0.load(Ordering::SeqCst), 1);
    assert_eq!(h.home.current_version().as_deref(), Some("1.5.0"));
    let pending = h.home.pending().unwrap();
    assert_eq!(
        (pending.from.as_str(), pending.to.as_str()),
        ("1.4.0", "1.5.0")
    );
    assert_eq!(h.restarts.load(Ordering::SeqCst), 1);
    assert_eq!(h.updater.status().phase, UpdatePhase::Restarting);
    // The download does not linger.
    assert!(!h
        .home
        .root()
        .join("downloads")
        .join("cognia-host-1.5.0-darwin-arm64.tar.gz")
        .exists());
}

#[tokio::test(start_paused = true)]
async fn a_host_that_turns_busy_at_the_last_gate_keeps_the_staged_version() {
    let h = harness();
    h.updater.request_install().await.unwrap();
    let busy = IdleReport {
        active_runs: Some(1),
        ..IdleReport::default()
    };
    // Idle when the tick looks, busy by the time it would switch.
    h.idle.set(vec![quiet(), busy]);
    h.updater.tick().await;
    assert!(h.home.version_dir("1.5.0").is_dir(), "staged");
    assert_eq!(h.home.current_version().as_deref(), Some("1.4.0"));
    assert_eq!(h.updater.status().phase, UpdatePhase::WaitingForIdle);
    assert_eq!(h.restarts.load(Ordering::SeqCst), 0);

    // Once idle again it switches without downloading twice.
    h.idle.set(vec![quiet()]);
    h.updater.tick().await;
    assert_eq!(h.network.downloads.load(Ordering::SeqCst), 1);
    assert_eq!(h.home.current_version().as_deref(), Some("1.5.0"));
    assert_eq!(h.restarts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_host_that_cannot_install_says_why() {
    for (reason, phrase) in [
        (UnmanagedReason::NotInstalled, "service install"),
        (UnmanagedReason::NotAService, "OS service"),
        (UnmanagedReason::NoDeployAgent, "deploy agent"),
        (UnmanagedReason::DesktopApp, "Update Center"),
    ] {
        let h = harness_with(|_| InstallKind::Unmanaged(reason), true);
        let error = h.updater.request_install().await.unwrap_err();
        assert!(error.contains(phrase), "{reason:?}: {error}");
        // It can still say what is available.
        assert!(h.updater.check(false).await.unwrap().available.is_some());
        assert_eq!(h.updater.status().install, "unmanaged");
    }
}

/// Stage 1.5.0 and switch to it, as the previous process did.
fn switched(h: &Harness) -> cognia_host_service::install_home::PendingUpdate {
    let archive = h.network.archive.lock().clone().unwrap();
    h.home
        .stage_archive(
            &archive,
            &cognia_host_service::install_home::ExpectedRelease {
                version: "1.5.0".into(),
                target: TARGET.into(),
                sha256: h.archive_sha.clone(),
                contract_version: 3,
                catalog_hash: cognia_host_service::test_support::TEST_CATALOG_HASH.into(),
            },
        )
        .unwrap();
    h.home
        .begin_switch("1.5.0", BASE_MS, 10 * 60 * 1000)
        .unwrap()
}

#[tokio::test(start_paused = true)]
async fn a_trial_commits_once_its_brain_stays_accepted() {
    let h = harness();
    let pending = switched(&h);
    let outcome = Arc::clone(&h.updater)
        .supervise_trial(
            h.home.clone(),
            pending,
            Arc::new(FixedHealth(TrialSignal::Healthy)),
            Duration::from_secs(1),
            Duration::from_secs(30),
        )
        .await;
    assert_eq!(outcome.result, UpdateResult::Installed);
    assert_eq!(h.home.current_version().as_deref(), Some("1.5.0"));
    assert_eq!(h.home.pending(), None);
    assert_eq!(h.restarts.load(Ordering::SeqCst), 0);
    assert_eq!(h.updater.status().last_outcome.unwrap().to, "1.5.0");
}

#[tokio::test(start_paused = true)]
async fn a_trial_rolls_back_when_its_brain_is_refused() {
    let h = harness();
    let pending = switched(&h);
    let outcome = Arc::clone(&h.updater)
        .supervise_trial(
            h.home.clone(),
            pending,
            Arc::new(FixedHealth(TrialSignal::Refused(
                "contract_mismatch".into(),
            ))),
            Duration::from_secs(1),
            Duration::from_secs(30),
        )
        .await;
    assert_eq!(outcome.result, UpdateResult::RolledBack);
    assert!(outcome.reason.unwrap().contains("contract_mismatch"));
    assert_eq!(h.home.current_version().as_deref(), Some("1.4.0"));
    assert_eq!(h.restarts.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_trial_that_never_gets_healthy_rolls_back_at_its_deadline() {
    let h = harness();
    let pending = switched(&h);
    let outcome = Arc::clone(&h.updater)
        .supervise_trial(
            h.home.clone(),
            pending,
            Arc::new(FixedHealth(TrialSignal::Waiting)),
            Duration::from_secs(5),
            Duration::from_secs(30),
        )
        .await;
    assert_eq!(outcome.result, UpdateResult::RolledBack);
    assert!(outcome.reason.unwrap().contains("in time"));
    assert_eq!(h.home.current_version().as_deref(), Some("1.4.0"));
}

#[test]
fn detects_how_the_host_is_installed() {
    let tmp = tempfile::tempdir().unwrap();
    let unpacked = tmp.path().join("unpacked");
    write_install(&unpacked, "1.4.0", TARGET);
    let home = InstallHome::in_data_dir(&tmp.path().join("data"));
    home.adopt(&unpacked).unwrap();
    let in_home = home.current_layout().server_binary();
    let detect = |exe: Option<&Path>, service_managed: bool, image_target: Option<&str>| {
        HostInstall::detect(&DetectInput {
            current_exe: exe,
            service_managed,
            image_target,
            compiled_version: "9.9.9",
        })
    };

    let native = detect(Some(&in_home), true, None);
    assert_eq!(native.kind, InstallKind::Native(home.clone()));
    assert_eq!(
        (native.version.as_str(), native.target.as_deref()),
        ("1.4.0", Some(TARGET))
    );
    assert_eq!(
        detect(Some(&in_home), false, None).kind,
        InstallKind::Unmanaged(UnmanagedReason::NotAService)
    );
    assert_eq!(
        detect(Some(&unpacked.join("bin/cognia-server")), true, None).kind,
        InstallKind::Unmanaged(UnmanagedReason::NotInstalled)
    );
    let image = detect(None, false, Some("oci-full-amd64"));
    assert_eq!(
        image.kind,
        InstallKind::Unmanaged(UnmanagedReason::NoDeployAgent)
    );
    assert_eq!(
        (image.version.as_str(), image.target.as_deref()),
        ("9.9.9", Some("oci-full-amd64"))
    );
    assert_eq!(
        detect(None, false, None).kind,
        InstallKind::Unmanaged(UnmanagedReason::NotInstalled)
    );
}

#[test]
fn the_desktop_app_reports_that_it_updates_elsewhere() {
    let status = super::status_value("0.9.0");
    assert_eq!(status["install"], "unmanaged");
    assert_eq!(status["unmanagedReason"], "desktop-app");
    assert_eq!(status["currentVersion"], "0.9.0");
}
