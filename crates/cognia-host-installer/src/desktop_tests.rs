//! The desktop's session registry over the scripted Linux host.

use std::sync::Arc;

use parking_lot::Mutex;

use super::*;
use crate::session::{StageEvent, StageOutcome};
use crate::shell::{ExecOutput, RemoteOutcome};
use crate::test_support::{
    hex_sha256, linux_host, release_bundle, FakeNetwork, FakeShell, DATA, INSTALLED, NOW_MS,
};

const SECRET: &str = "cgnp4|owner-invitation-SECRET";

#[derive(Default)]
struct Events(Mutex<Vec<StageEvent>>);

impl StageObserver for Events {
    fn on_stage(&self, event: &StageEvent) {
        self.0.lock().push(event.clone());
    }
}

const ARCHIVE: &[u8] = b"cognia-host-1.4.0-linux-x64 archive bytes";

fn release(dir: &std::path::Path) -> ReleaseConfig {
    ReleaseConfig {
        network: Arc::new(FakeNetwork {
            bundle: Some(release_bundle("linux-x64", &hex_sha256(ARCHIVE))),
            archive: ARCHIVE.to_vec(),
        }),
        root: Some(cognia_update_catalog::test_support::root()),
        trust: TrustFile::new(dir.join("trust.json")),
        download_dir: dir.join("downloads"),
        now_ms: || NOW_MS,
    }
}

fn stable() -> InstallChoice {
    InstallChoice {
        channel: "stable".into(),
        local_account_id: Some("local_acct_a".into()),
    }
}

fn registered(shell: &Arc<FakeShell>) -> (InstallerSessions, String) {
    let sessions = InstallerSessions::new();
    let id = sessions.insert(shell.clone());
    (sessions, id)
}

fn pair_argv(device: &str) -> Vec<&str> {
    vec![INSTALLED, "pair", "--json", "--device-name", device]
}

#[tokio::test]
async fn an_inspection_is_shown_as_the_consent_copy_needs_it() {
    let shell = linux_host();
    let (sessions, id) = registered(&shell);
    let events = Events::default();

    let inspection = sessions.inspect(&id, &events).await.expect("inspect");
    assert!(inspection.inspection_id.starts_with("inst-"));
    assert_eq!(inspection.os, "linux");
    assert_eq!(inspection.arch, "x64");
    assert_eq!(inspection.target, "linux-x64");
    assert_eq!(inspection.hostname, "VM-0-8-ubuntu");
    assert_eq!(inspection.user, "ubuntu");
    assert_eq!(inspection.data_dir, DATA);
    assert_eq!(inspection.service_manager, "systemd");
    assert_eq!(inspection.linger, Some(false));
    assert_eq!(inspection.glibc.as_deref(), Some("2.35"));
    assert_eq!(inspection.free_bytes, Some(52_428_800 * 1024));
    assert_eq!(inspection.existing, None);
    assert_eq!(inspection.offers, vec![PlanKind::Fresh]);

    let json = serde_json::to_value(&inspection).unwrap();
    assert_eq!(json["notices"], serde_json::json!(["linger_off"]));
    assert_eq!(json["offers"], serde_json::json!(["fresh"]));
    assert_eq!(json["serviceManager"], "systemd");
    assert_eq!(
        events.0.lock().len(),
        4,
        "probe and plan, started and ended"
    );
}

#[tokio::test]
async fn a_fresh_install_fetches_installs_and_pairs_on_the_inspected_plan() {
    let dir = tempfile::tempdir().unwrap();
    let shell = linux_host();
    shell.answer(
        &pair_argv("Max's Mac"),
        0,
        &format!(
            r#"{{"status":"issued","invitation":"{SECRET}","hasRelay":true,"expiresAtMs":9}}"#
        ),
    );
    let (sessions, id) = registered(&shell);
    let events = Events::default();
    let inspection = sessions.inspect(&id, &events).await.unwrap();

    let installed = sessions
        .install(
            &id,
            &inspection.inspection_id,
            PlanKind::Fresh,
            &stable(),
            &release(dir.path()),
            &events,
        )
        .await
        .expect("install");
    assert_eq!(installed.version, "1.4.0");
    assert_eq!(installed.data_dir, DATA);
    // The archive was downloaded here, then uploaded, and the service runs
    // as the chosen account's Host.
    assert!(dir
        .path()
        .join("downloads/cognia-host-1.4.0-linux-x64.tar.gz")
        .exists());
    assert_eq!(
        shell
            .machine
            .lock()
            .state
            .get("installed")
            .map(String::as_str),
        Some("1.4.0")
    );
    let stages: Vec<StageName> = events
        .0
        .lock()
        .iter()
        .filter(|event| event.outcome == Some(StageOutcome::Ok))
        .map(|event| event.stage)
        .collect();
    assert_eq!(
        stages,
        vec![
            StageName::Probe,
            StageName::Plan,
            StageName::Fetch,
            StageName::Upload,
            StageName::Stage,
            StageName::Service,
        ]
    );
    // SSH publishes no route, so no tunnel ingress is enabled.
    assert!(!shell
        .commands()
        .iter()
        .any(|argv| argv.iter().any(|part| part == "tunnel-ingress")));

    let paired = sessions
        .pair(
            &id,
            &inspection.inspection_id,
            PlanKind::Fresh,
            "Max's Mac",
            &events,
        )
        .await
        .expect("pair");
    assert_eq!(paired.invitation, SECRET);
    assert!(paired.has_relay);
    assert!(!format!("{paired:?}").contains(SECRET));
    for event in events.0.lock().iter() {
        assert!(!serde_json::to_string(event).unwrap().contains(SECRET));
    }
}

#[tokio::test]
async fn every_step_is_bound_to_the_latest_inspection_and_an_offered_plan() {
    let dir = tempfile::tempdir().unwrap();
    let shell = linux_host();
    let (sessions, id) = registered(&shell);
    let events = Events::default();

    // Nothing inspected yet.
    assert_eq!(
        sessions
            .pair(&id, "inst-x", PlanKind::Fresh, "Mac", &events)
            .await,
        Err(InstallerFailure::StaleInspection)
    );
    let first = sessions.inspect(&id, &events).await.unwrap();
    let second = sessions.inspect(&id, &events).await.unwrap();
    assert_ne!(first.inspection_id, second.inspection_id);
    assert_eq!(
        sessions
            .install(
                &id,
                &first.inspection_id,
                PlanKind::Fresh,
                &stable(),
                &release(dir.path()),
                &events,
            )
            .await,
        Err(InstallerFailure::StaleInspection)
    );
    // Uninstall was not offered for an empty machine.
    assert!(matches!(
        sessions
            .uninstall(&id, &second.inspection_id, None, &events)
            .await,
        Err(InstallerFailure::Denied { .. })
    ));
    assert_eq!(
        sessions
            .inspect("hi-unknown", &events)
            .await
            .map(|view| view.inspection_id),
        Err(InstallerFailure::NoSession)
    );
    assert!(sessions.close(&id));
    assert!(!sessions.close(&id));
    assert_eq!(
        sessions.inspect(&id, &events).await.map(|_| ()),
        Err(InstallerFailure::NoSession)
    );
}

#[tokio::test]
async fn steps_on_one_session_never_overlap() {
    let shell = linux_host();
    let (sessions, id) = registered(&shell);
    let entry = sessions.entry(&id).unwrap();
    let _running = entry.busy.try_lock().unwrap();
    assert_eq!(
        sessions.inspect(&id, &Events::default()).await.map(|_| ()),
        Err(InstallerFailure::Busy)
    );
}

#[tokio::test]
async fn uninstall_takes_the_typed_name_and_forgets_the_inspection() {
    let shell = linux_host();
    {
        let mut machine = shell.machine.lock();
        machine.files.insert(INSTALLED.into(), b"server".to_vec());
        machine.state.insert("installed".into(), "1.4.0".into());
        machine.state.insert("key".into(), "existing".into());
    }
    let (sessions, id) = registered(&shell);
    let events = Events::default();
    let inspection = sessions.inspect(&id, &events).await.unwrap();
    assert_eq!(
        inspection.offers,
        vec![PlanKind::Repair, PlanKind::RePair, PlanKind::Uninstall]
    );
    let existing = inspection.existing.clone().expect("existing install");
    assert_eq!(existing.version.as_deref(), Some("1.4.0"));
    assert!(existing.master_key_present);

    assert!(matches!(
        sessions
            .uninstall(
                &id,
                &inspection.inspection_id,
                Some("not-the-name"),
                &events
            )
            .await,
        Err(InstallerFailure::Denied { .. })
    ));
    sessions
        .uninstall(
            &id,
            &inspection.inspection_id,
            Some("VM-0-8-ubuntu"),
            &events,
        )
        .await
        .expect("uninstall");
    assert!(shell
        .machine
        .lock()
        .state
        .contains_key(&format!("removed:{DATA}")));
    assert_eq!(
        sessions
            .uninstall(&id, &inspection.inspection_id, None, &events)
            .await,
        Err(InstallerFailure::StaleInspection)
    );
}

#[tokio::test]
async fn an_unsupported_machine_arrives_with_its_cause() {
    let shell = linux_host();
    shell.rescript(
        &["getconf", "GNU_LIBC_VERSION"],
        RemoteOutcome::Completed(ExecOutput {
            exit_code: Some(0),
            stdout: "glibc 2.31\n".into(),
            stderr: String::new(),
            truncated: false,
        }),
    );
    let (sessions, id) = registered(&shell);
    let failure = sessions.inspect(&id, &Events::default()).await.unwrap_err();
    let json = serde_json::to_value(&failure).unwrap();
    assert_eq!(json["kind"], "unsupported");
    assert_eq!(
        json["reason"],
        serde_json::json!({ "cause": "glibc_too_old", "found": "2.31", "baseline": "2.35" })
    );
}

#[test]
fn a_changed_host_key_stays_machine_readable() {
    let change = HostKeyChange {
        host: "box".into(),
        port: 22,
        known_fingerprint: Some("SHA256:old".into()),
        presented_fingerprint: "SHA256:new".into(),
    };
    let message = format!(
        "{HOST_KEY_CHANGED_CODE}:{}",
        serde_json::to_string(&change).unwrap()
    );
    assert_eq!(
        connect_failure(message),
        InstallerFailure::HostKeyChanged {
            change: change.clone()
        }
    );
    assert_eq!(
        connect_failure("SSH authentication was rejected by the server".into()),
        InstallerFailure::Connect {
            message: "SSH authentication was rejected by the server".into()
        }
    );
    let json = serde_json::to_value(InstallerFailure::Unknown {
        stage: StageName::Upload,
        message: "dropped".into(),
    })
    .unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "kind": "unknown", "stage": "upload", "message": "dropped" })
    );
    assert_eq!(
        serde_json::to_value(InstallerFailure::Timeout {
            stage: StageName::Service
        })
        .unwrap(),
        serde_json::json!({ "kind": "timeout", "stage": "service" })
    );
    // A plan arrives from the renderer by its wire name.
    assert_eq!(
        serde_json::from_str::<PlanKind>(r#""re_pair""#).unwrap(),
        PlanKind::RePair
    );
}
