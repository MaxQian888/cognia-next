//! The session over a scripted Linux machine that answers like
//! `cognia-server` does.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use super::*;
use crate::release::{LocalArchive, VerifiedRelease};
use crate::shell::{RemoteOutcome, ShellError};
use crate::test_support::{
    hex_sha256, linux_host, output, release_bundle, FakeNetwork, FakeShell, DATA, HOME, INSTALLED,
    NOW_MS,
};

const SECRET: &str = "cgnp4|owner-invitation-SECRET";

#[derive(Default)]
struct Events(Mutex<Vec<StageEvent>>);

impl StageObserver for Events {
    fn on_stage(&self, event: &StageEvent) {
        self.0.lock().push(event.clone());
    }
}

impl Events {
    fn outcomes(&self) -> Vec<(StageName, Option<StageOutcome>)> {
        self.0
            .lock()
            .iter()
            .map(|event| (event.stage, event.outcome))
            .collect()
    }
}

fn fast() -> Deadlines {
    Deadlines {
        ready: Duration::from_millis(50),
        ready_poll: Duration::from_millis(5),
        ..Deadlines::default()
    }
}

fn local_archive(dir: &std::path::Path) -> LocalArchive {
    let bytes = b"cognia-host-1.4.0-linux-x64 archive bytes";
    let path = dir.join("cognia-host-1.4.0-linux-x64.tar.gz");
    std::fs::write(&path, bytes).unwrap();
    LocalArchive {
        release: VerifiedRelease {
            version: "1.4.0".into(),
            target: "linux-x64".into(),
            sha256: hex_sha256(bytes),
            contract_version: 3,
            catalog_hash: "c".repeat(64),
            url: "https://update.cognia.cn/a.tar.gz".into(),
            size_bytes: Some(bytes.len() as u64),
        },
        path,
        len: bytes.len() as u64,
    }
}

fn ingress() -> InstallOptions {
    InstallOptions {
        ingress_port: Some(27896),
        local_account_id: None,
    }
}

#[tokio::test]
async fn a_fresh_install_runs_every_stage_in_order_and_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let shell = linux_host();
    let events = Events::default();
    let session = Session::new(shell.as_ref(), &events).with_deadlines(fast());

    let inspection = session.inspect().await.expect("inspect");
    assert_eq!(inspection.target.target, "linux-x64");
    assert_eq!(inspection.data_dir, DATA);
    assert_eq!(inspection.existing, None);
    assert_eq!(inspection.offers, vec![PlanKind::Fresh]);
    assert_eq!(inspection.notices, vec![Notice::LingerOff]);

    let consent = Consent::grant(&inspection, PlanKind::Fresh).unwrap();
    let installed = session
        .install(
            &inspection,
            &consent,
            &local_archive(dir.path()),
            &ingress(),
        )
        .await
        .expect("install");
    assert_eq!(installed.version, "1.4.0");
    assert_eq!(installed.server_binary, INSTALLED);

    let commands = shell.commands();
    let position = |needle: &str| {
        commands
            .iter()
            .position(|argv| argv.iter().any(|part| part == needle))
            .unwrap_or_else(|| panic!("{needle} never ran"))
    };
    assert!(position("tunnel-ingress") < position("install"));
    assert_eq!(
        shell
            .machine
            .lock()
            .state
            .get("ingress")
            .map(String::as_str),
        Some("27896")
    );
    // The scratch work dir is removed once the service runs its own copy.
    assert!(shell
        .machine
        .lock()
        .state
        .contains_key("removed:/home/ubuntu/.cache/cognia-host-installer/1.4.0"));
    assert_eq!(
        events.outcomes(),
        vec![
            (StageName::Probe, None),
            (StageName::Probe, Some(StageOutcome::Ok)),
            (StageName::Plan, None),
            (StageName::Plan, Some(StageOutcome::Ok)),
            (StageName::Upload, None),
            (StageName::Upload, Some(StageOutcome::Ok)),
            (StageName::Stage, None),
            (StageName::Stage, Some(StageOutcome::Ok)),
            (StageName::Service, None),
            (StageName::Service, Some(StageOutcome::Ok)),
        ]
    );
}

#[tokio::test]
async fn an_upload_whose_remote_copy_already_verifies_is_not_repeated() {
    let dir = tempfile::tempdir().unwrap();
    let archive = local_archive(dir.path());
    let shell = linux_host();
    shell.machine.lock().files.insert(
        "/home/ubuntu/.cache/cognia-host-installer/1.4.0/cognia-host-1.4.0-linux-x64.tar.gz".into(),
        std::fs::read(&archive.path).unwrap(),
    );
    // Any upload would now fail loudly.
    shell.failing_uploads.lock().insert(
        "/home/ubuntu/.cache/cognia-host-installer/1.4.0/cognia-host-1.4.0-linux-x64.tar.gz".into(),
        RemoteOutcome::NotStarted(ShellError::Refused("uploaded twice".into())),
    );
    let session = Session::new(shell.as_ref(), &NoObserver).with_deadlines(fast());
    let inspection = session.inspect().await.unwrap();
    let consent = Consent::grant(&inspection, PlanKind::Fresh).unwrap();
    session
        .install(&inspection, &consent, &archive, &InstallOptions::default())
        .await
        .expect("install without a second upload");
    assert!(!shell
        .commands()
        .iter()
        .any(|argv| argv.iter().any(|a| a == "tunnel-ingress")));
}

#[tokio::test]
async fn every_stage_failure_is_typed_and_stops_the_session() {
    struct Case {
        name: &'static str,
        break_it: fn(&FakeShell),
        expect: fn(&InstallError) -> bool,
        retryable: bool,
    }
    let cases = [
        Case {
            name: "upload unknown",
            break_it: |shell| {
                shell.failing_uploads.lock().insert(
                    "/home/ubuntu/.cache/cognia-host-installer/1.4.0/cognia-host-1.4.0-linux-x64.tar.gz".into(),
                    RemoteOutcome::Unknown("helper crashed".into()),
                );
            },
            expect: |error| {
                matches!(
                    error,
                    InstallError::Unknown {
                        stage: StageName::Upload,
                        ..
                    }
                )
            },
            retryable: false,
        },
        Case {
            name: "upload fault",
            break_it: |shell| {
                shell.failing_uploads.lock().insert(
                    "/home/ubuntu/.cache/cognia-host-installer/1.4.0/cognia-host-1.4.0-linux-x64.tar.gz".into(),
                    RemoteOutcome::NotStarted(ShellError::Fault("tunnel down".into())),
                );
            },
            expect: |error| {
                matches!(
                    error,
                    InstallError::Fault {
                        stage: StageName::Upload,
                        ..
                    }
                )
            },
            retryable: true,
        },
        Case {
            name: "extract fails",
            break_it: |shell| {
                shell.rescript(
                    &[
                        "tar",
                        "-xzf",
                        "/home/ubuntu/.cache/cognia-host-installer/1.4.0/cognia-host-1.4.0-linux-x64.tar.gz",
                        "-C",
                        "/home/ubuntu/.cache/cognia-host-installer/1.4.0/extract",
                        "cognia-host-1.4.0-linux-x64/bin/cognia-server",
                    ],
                    output(2, ""),
                );
            },
            expect: |error| {
                matches!(
                    error,
                    InstallError::Failed {
                        stage: StageName::Stage,
                        ..
                    }
                )
            },
            retryable: false,
        },
        Case {
            name: "service never ready",
            break_it: |shell| {
                shell
                    .machine
                    .lock()
                    .state
                    .insert("never-ready".into(), String::new());
            },
            expect: |error| {
                matches!(
                    error,
                    InstallError::Timeout {
                        stage: StageName::Service
                    }
                )
            },
            retryable: true,
        },
    ];
    for case in cases {
        let dir = tempfile::tempdir().unwrap();
        let shell = linux_host();
        let events = Events::default();
        let session = Session::new(shell.as_ref(), &events).with_deadlines(fast());
        let inspection = session.inspect().await.unwrap();
        let consent = Consent::grant(&inspection, PlanKind::Fresh).unwrap();
        (case.break_it)(&shell);
        let error = session
            .install(
                &inspection,
                &consent,
                &local_archive(dir.path()),
                &ingress(),
            )
            .await
            .expect_err(case.name);
        assert!((case.expect)(&error), "{}: {error:?}", case.name);
        assert_eq!(error.retryable(), case.retryable, "{}", case.name);
        // The failed stage reported its outcome and nothing ran after it.
        let last = events.outcomes().last().copied().unwrap();
        assert_eq!(last.1, Some(error.outcome()), "{}", case.name);
        if !matches!(error, InstallError::Timeout { .. }) {
            assert!(
                !shell
                    .commands()
                    .iter()
                    .any(|argv| argv.get(1).is_some_and(|a| a == "service")
                        && argv.get(2).is_some_and(|a| a == "install")),
                "{}: the service was installed after a failure",
                case.name
            );
        }
    }
}

#[tokio::test]
async fn an_unknown_exec_is_never_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let shell = linux_host();
    let session = Session::new(shell.as_ref(), &NoObserver).with_deadlines(fast());
    let inspection = session.inspect().await.unwrap();
    let consent = Consent::grant(&inspection, PlanKind::Fresh).unwrap();
    let extract = [
        "tar",
        "-xzf",
        "/home/ubuntu/.cache/cognia-host-installer/1.4.0/cognia-host-1.4.0-linux-x64.tar.gz",
        "-C",
        "/home/ubuntu/.cache/cognia-host-installer/1.4.0/extract",
        "cognia-host-1.4.0-linux-x64/bin/cognia-server",
    ];
    shell.unknown(&extract);
    let error = session
        .install(
            &inspection,
            &consent,
            &local_archive(dir.path()),
            &ingress(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        InstallError::Unknown {
            stage: StageName::Stage,
            ..
        }
    ));
    assert!(!error.retryable());
    let ran = shell
        .commands()
        .iter()
        .filter(|argv| argv.first().is_some_and(|program| program == "tar"))
        .count();
    assert_eq!(ran, 1, "an unknown outcome was replayed");
}

#[tokio::test]
async fn a_repair_keeps_the_existing_master_key_and_data() {
    let dir = tempfile::tempdir().unwrap();
    let shell = linux_host();
    {
        let mut machine = shell.machine.lock();
        machine.files.insert(INSTALLED.into(), b"server".to_vec());
        machine.state.insert("installed".into(), "1.3.0".into());
        machine.state.insert("key".into(), "existing".into());
    }
    let session = Session::new(shell.as_ref(), &NoObserver).with_deadlines(fast());
    let inspection = session.inspect().await.unwrap();
    let existing = inspection.existing.as_ref().expect("existing install");
    assert!(existing.master_key_present);
    assert_eq!(
        inspection.offers,
        vec![PlanKind::Repair, PlanKind::RePair, PlanKind::Uninstall]
    );
    assert!(Consent::grant(&inspection, PlanKind::Fresh).is_err());
    let consent = Consent::grant(&inspection, PlanKind::Repair).unwrap();
    session
        .install(
            &inspection,
            &consent,
            &local_archive(dir.path()),
            &ingress(),
        )
        .await
        .expect("repair");
    assert_eq!(
        shell.machine.lock().state.get("key").map(String::as_str),
        Some("existing")
    );
    // Nothing in a repair removes the data dir or the key.
    for argv in shell.commands() {
        if argv.first().is_some_and(|program| program == "rm") {
            let target = argv.last().unwrap();
            assert!(
                target.starts_with("/home/ubuntu/.cache/cognia-host-installer/"),
                "a repair removed {target}"
            );
        }
        assert!(!argv.iter().any(|part| part.ends_with("master.key")));
    }
}

#[tokio::test]
async fn consent_is_bound_to_its_inspection_and_its_plan() {
    let dir = tempfile::tempdir().unwrap();
    let shell = linux_host();
    let session = Session::new(shell.as_ref(), &NoObserver).with_deadlines(fast());
    let first = session.inspect().await.unwrap();
    let second = session.inspect().await.unwrap();
    assert_ne!(first.id, second.id);
    let stale = Consent::grant(&first, PlanKind::Fresh).unwrap();
    let error = session
        .install(&second, &stale, &local_archive(dir.path()), &ingress())
        .await
        .unwrap_err();
    assert_eq!(error.outcome(), StageOutcome::Denied);
    assert!(shell
        .commands()
        .iter()
        .all(|argv| argv.first().is_some_and(|p| p != "tar")));
    // An archive for another platform is refused before anything runs.
    let mut other = local_archive(dir.path());
    other.release.target = "linux-arm64".into();
    let consent = Consent::grant(&second, PlanKind::Fresh).unwrap();
    assert!(matches!(
        session.install(&second, &consent, &other, &ingress()).await,
        Err(InstallError::Denied(_))
    ));
}

#[tokio::test]
async fn a_machine_without_room_is_refused_before_the_upload() {
    let dir = tempfile::tempdir().unwrap();
    let shell = linux_host();
    shell.rescript(
        &["df", "-Pk", HOME],
        output(
            0,
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1 1 1024 99% /\n",
        ),
    );
    let session = Session::new(shell.as_ref(), &NoObserver).with_deadlines(fast());
    let inspection = session.inspect().await.unwrap();
    let consent = Consent::grant(&inspection, PlanKind::Fresh).unwrap();
    let error = session
        .install(
            &inspection,
            &consent,
            &local_archive(dir.path()),
            &ingress(),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, InstallError::NotEnoughSpace { .. }));
}

async fn installed_host() -> (Arc<FakeShell>, Inspection) {
    let shell = linux_host();
    {
        let mut machine = shell.machine.lock();
        machine.files.insert(INSTALLED.into(), b"server".to_vec());
        machine.state.insert("installed".into(), "1.4.0".into());
        machine.state.insert("key".into(), "existing".into());
    }
    let inspection = Session::new(shell.as_ref(), &NoObserver)
        .inspect()
        .await
        .unwrap();
    (shell, inspection)
}

fn pair_argv(direct: Option<&str>) -> Vec<String> {
    let mut argv = vec![
        INSTALLED,
        "pair",
        "--json",
        "--device-name",
        "Max's MacBook",
    ];
    if let Some(url) = direct {
        argv.extend(["--direct", "--advertise-url", url]);
    }
    argv.into_iter().map(String::from).collect()
}

#[tokio::test]
async fn a_relay_less_host_pairs_over_the_tunnel_only_with_its_own_consent() {
    let (shell, inspection) = installed_host().await;
    let refused = r#"{"status":"refused","cause":"relay_unavailable","message":"no relay invitation: the relay is switched off"}"#;
    let argv = pair_argv(None);
    let argv_ref: Vec<&str> = argv.iter().map(String::as_str).collect();
    shell.answer(&argv_ref, 0, refused);
    let tunnel = "https://abc-27896.usw2.devtunnels.ms";
    let direct = pair_argv(Some(tunnel));
    let direct_ref: Vec<&str> = direct.iter().map(String::as_str).collect();
    shell.answer(
        &direct_ref,
        0,
        &format!(
            r#"{{"status":"issued","invitation":"{SECRET}","hasRelay":false,"expiresAtMs":9}}"#
        ),
    );
    let session = Session::new(shell.as_ref(), &NoObserver);

    let consent = Consent::grant(&inspection, PlanKind::RePair).unwrap();
    let error = session
        .pair(&inspection, &consent, "Max's MacBook", Some(tunnel))
        .await
        .unwrap_err();
    assert!(matches!(error, InstallError::RelayUnavailable { .. }));
    assert!(
        !shell
            .commands()
            .iter()
            .any(|argv| argv.iter().any(|part| part == "--direct")),
        "a tunnel-only invitation was asked for without consent"
    );

    let consent = consent.with_tunnel_only_pairing();
    let invitation = session
        .pair(&inspection, &consent, "Max's MacBook", Some(tunnel))
        .await
        .expect("tunnel-only pairing");
    assert_eq!(invitation.encoded.as_str(), SECRET);
    assert!(!invitation.has_relay);
    // Every pair exec was marked as carrying a secret.
    assert!(shell
        .log
        .lock()
        .iter()
        .filter(|request| request.argv.get(1).is_some_and(|a| a == "pair"))
        .all(|request| request.secret_output));
}

#[tokio::test]
async fn the_invitation_never_reaches_an_error_an_event_or_debug_output() {
    let (shell, inspection) = installed_host().await;
    let argv = pair_argv(None);
    let argv_ref: Vec<&str> = argv.iter().map(String::as_str).collect();
    shell.answer(
        &argv_ref,
        0,
        &format!(
            r#"{{"status":"issued","invitation":"{SECRET}","hasRelay":true,"expiresAtMs":9}}"#
        ),
    );
    let events = Events::default();
    let session = Session::new(shell.as_ref(), &events);
    let consent = Consent::grant(&inspection, PlanKind::RePair).unwrap();
    let invitation = session
        .pair(&inspection, &consent, "Max's MacBook", None)
        .await
        .unwrap();
    assert!(!format!("{invitation:?}").contains("SECRET"));
    assert!(!serde_json::to_string(&*events.0.lock())
        .unwrap()
        .contains("SECRET"));

    // A failing pair whose output holds the invitation reports only its exit.
    shell.rescript(
        &argv_ref,
        RemoteOutcome::Completed(crate::shell::ExecOutput {
            exit_code: Some(1),
            stdout: SECRET.into(),
            stderr: SECRET.into(),
            truncated: false,
        }),
    );
    let error = session
        .pair(&inspection, &consent, "Max's MacBook", None)
        .await
        .unwrap_err();
    assert!(!error.to_string().contains("SECRET"));
    assert!(!format!("{error:?}").contains("SECRET"));
    let output = crate::shell::ExecOutput {
        exit_code: Some(0),
        stdout: SECRET.into(),
        stderr: String::new(),
        truncated: false,
    };
    assert!(!format!("{output:?}").contains("SECRET"));
}

#[tokio::test]
async fn uninstall_keeps_data_unless_the_machine_name_is_typed() {
    let (shell, inspection) = installed_host().await;
    let session = Session::new(shell.as_ref(), &NoObserver);
    assert!(Consent::grant(&inspection, PlanKind::Repair)
        .unwrap()
        .with_data_deletion(&inspection, "VM-0-8-ubuntu")
        .is_err());
    let consent = Consent::grant(&inspection, PlanKind::Uninstall).unwrap();
    assert!(consent
        .clone()
        .with_data_deletion(&inspection, "the wrong name")
        .is_err());

    session
        .uninstall(&inspection, &consent)
        .await
        .expect("uninstall");
    {
        let machine = shell.machine.lock();
        assert!(!machine.state.contains_key("installed"));
        assert!(machine
            .state
            .contains_key(&format!("removed:{DATA}/install")));
        assert!(!machine.state.contains_key(&format!("removed:{DATA}")));
    }

    let consent = consent
        .with_data_deletion(&inspection, " VM-0-8-ubuntu ")
        .expect("typed name");
    session
        .uninstall(&inspection, &consent)
        .await
        .expect("uninstall with data");
    assert!(shell
        .machine
        .lock()
        .state
        .contains_key(&format!("removed:{DATA}")));
}

#[tokio::test]
async fn an_unsupported_machine_is_refused_at_probe_time() {
    let shell = linux_host();
    shell.rescript(&["getconf", "GNU_LIBC_VERSION"], output(0, "glibc 2.31\n"));
    let events = Events::default();
    let error = Session::new(shell.as_ref(), &events)
        .inspect()
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        InstallError::Unsupported(Unsupported::GlibcTooOld { .. })
    ));
    assert_eq!(
        events.outcomes().last().copied(),
        Some((StageName::Probe, Some(StageOutcome::Unsupported)))
    );
}

#[tokio::test]
async fn fetch_takes_the_signed_release_for_the_machine_and_reports_the_stage() {
    let dir = tempfile::tempdir().unwrap();
    let shell = linux_host();
    let events = Events::default();
    let session = Session::new(shell.as_ref(), &events).with_deadlines(fast());
    let inspection = session.inspect().await.expect("inspect");
    let consent = Consent::grant(&inspection, PlanKind::Fresh).unwrap();

    let bytes = b"the linux-x64 archive".to_vec();
    let network = FakeNetwork {
        bundle: Some(release_bundle("linux-x64", &hex_sha256(&bytes))),
        archive: bytes.clone(),
    };
    let trust = cognia_update_catalog::client::TrustFile::new(dir.path().join("trust.json"));
    let root = cognia_update_catalog::test_support::root();
    let downloads = dir.path().join("downloads");
    let source = ReleaseSource {
        network: &network,
        root: Some(&root),
        trust: &trust,
        channel: "stable",
        download_dir: &downloads,
        now_ms: NOW_MS,
    };
    let archive = session
        .fetch(&inspection, &consent, &source)
        .await
        .expect("fetch");
    assert_eq!(archive.release.target, "linux-x64");
    assert_eq!(std::fs::read(&archive.path).unwrap(), bytes);
    assert_eq!(
        events.outcomes()[4..],
        [
            (StageName::Fetch, None),
            (StageName::Fetch, Some(StageOutcome::Ok)),
        ]
    );

    // No release for this target: a typed failure, and nothing downloaded.
    let elsewhere = FakeNetwork {
        bundle: Some(release_bundle("darwin-arm64", &hex_sha256(&bytes))),
        archive: bytes,
    };
    let error = session
        .fetch(
            &inspection,
            &consent,
            &ReleaseSource {
                network: &elsewhere,
                ..source
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        InstallError::Release(ReleaseError::NoRelease { .. })
    ));

    // Re-pairing never downloads anything.
    let installed = Inspection {
        offers: vec![PlanKind::RePair],
        ..inspection.clone()
    };
    let re_pair = Consent::grant(&installed, PlanKind::RePair).unwrap();
    assert!(matches!(
        session.fetch(&installed, &re_pair, &source).await,
        Err(InstallError::Denied(_))
    ));
}
