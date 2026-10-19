use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cognia_terminal::sftp_memory::{self, MemoryFs};
use cognia_terminal::ssh::{SshExecError, SshExecOutput};
use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use sha2::{Digest, Sha256};

use super::*;

/// A link whose exec answers from a script and records what it was sent, and
/// whose SFTP is a real server in memory.
struct FakeLink {
    sent: Mutex<Vec<(String, Vec<u8>, Duration, usize)>>,
    answer: Mutex<Box<dyn FnMut(&str) -> Result<SshExecOutput, SshExecError> + Send>>,
    sftp_opened: Arc<Mutex<u32>>,
    sftp_fails: bool,
}

impl FakeLink {
    fn answering(
        answer: impl FnMut(&str) -> Result<SshExecOutput, SshExecError> + Send + 'static,
    ) -> Self {
        Self {
            sent: Mutex::new(Vec::new()),
            answer: Mutex::new(Box::new(answer)),
            sftp_opened: Arc::new(Mutex::new(0)),
            sftp_fails: false,
        }
    }

    fn exits(code: i32) -> Self {
        Self::answering(move |_| Ok(output(Some(code), "", "")))
    }
}

fn output(exit_code: Option<i32>, stdout: &str, stderr: &str) -> SshExecOutput {
    SshExecOutput {
        exit_code,
        stdout: stdout.as_bytes().to_vec(),
        stderr: stderr.as_bytes().to_vec(),
        truncated: false,
    }
}

#[async_trait]
impl SshLink for FakeLink {
    async fn exec(
        &self,
        command: &str,
        stdin: &[u8],
        wait: Duration,
        max_output_bytes: usize,
    ) -> Result<SshExecOutput, SshExecError> {
        let script = String::from_utf8_lossy(stdin).into_owned();
        self.sent
            .lock()
            .push((command.to_owned(), stdin.to_vec(), wait, max_output_bytes));
        (self.answer.lock())(&script)
    }

    async fn sftp(&self) -> Result<SftpSession, String> {
        if self.sftp_fails {
            return Err("subsystem refused".into());
        }
        *self.sftp_opened.lock() += 1;
        Ok(sftp_memory::connect(MemoryFs::seeded()).await)
    }
}

fn source(bytes: &[u8]) -> UploadSource {
    UploadSource {
        len: bytes.len() as u64,
        sha256: hex::encode(Sha256::digest(bytes)),
        reader: Box::new(std::io::Cursor::new(bytes.to_vec())),
    }
}

#[test]
fn a_request_becomes_one_posix_script_with_every_word_quoted() {
    let request = ExecRequest::new(
        [
            "/home/max/bin/cognia-server",
            "pair",
            "--device-name",
            "Max's Mac $HOME",
        ],
        Duration::from_secs(5),
    );
    assert_eq!(
        posix_script(&request).unwrap(),
        "exec '/home/max/bin/cognia-server' 'pair' '--device-name' 'Max'\\''s Mac $HOME' </dev/null\n"
    );

    let mut request = ExecRequest::new(["tar", "-xzf", "a b.tgz"], Duration::from_secs(5))
        .env("COGNIA_DATA_DIR", "/home/max/.local/share/cognia-server")
        .env("NOTE", "it's\nmultiline");
    request.cwd = Some("/tmp/it's".into());
    assert_eq!(
        posix_script(&request).unwrap(),
        "cd -- '/tmp/it'\\''s' || exit 125\n\
         exec env 'COGNIA_DATA_DIR=/home/max/.local/share/cognia-server' 'NOTE=it'\\''s\nmultiline' \
         'tar' '-xzf' 'a b.tgz' </dev/null\n"
    );
}

#[test]
fn a_request_the_script_cannot_express_is_refused() {
    let none: [&str; 0] = [];
    assert!(posix_script(&ExecRequest::new(none, Duration::ZERO)).is_err());
    assert!(posix_script(&ExecRequest::new(["a\0b"], Duration::ZERO)).is_err());
    assert!(posix_script(&ExecRequest::new(["x"], Duration::ZERO).env("1BAD", "v")).is_err());
    assert!(posix_script(&ExecRequest::new(["A=B"], Duration::ZERO).env("K", "v")).is_err());
    // Without an environment `exec` takes any program name.
    assert!(posix_script(&ExecRequest::new(["A=B"], Duration::ZERO)).is_ok());
}

#[tokio::test]
async fn every_exec_is_sh_reading_its_script_from_stdin() {
    let shell = SshShell::new(FakeLink::answering(|_| {
        Ok(SshExecOutput {
            exit_code: Some(3),
            stdout: b"out\xff".to_vec(),
            stderr: b"err".to_vec(),
            truncated: true,
        })
    }));
    let mut request = ExecRequest::new(["uname", "-s"], Duration::from_secs(9));
    request.max_output_bytes = 77;
    let RemoteOutcome::Completed(output) = shell.exec(request).await else {
        panic!("completed");
    };
    assert_eq!(output.exit_code, Some(3));
    assert_eq!(output.stdout, "out\u{fffd}");
    assert_eq!(output.stderr, "err");
    assert!(output.truncated);

    let sent = shell.link().sent.lock();
    let (command, stdin, wait, max) = &sent[0];
    assert_eq!(command, SCRIPT_RUNNER);
    assert_eq!(stdin.as_slice(), b"exec 'uname' '-s' </dev/null\n");
    assert_eq!(*wait, Duration::from_secs(9));
    assert_eq!(*max, 77);
}

#[tokio::test]
async fn exec_failures_keep_the_line_between_not_started_and_unknown() {
    for (error, expected) in [
        (
            SshExecError::NotSent("no channel".into()),
            RemoteOutcome::NotStarted(ShellError::Fault("no channel".into())),
        ),
        (
            SshExecError::Rejected("denied".into()),
            RemoteOutcome::NotStarted(ShellError::Refused("denied".into())),
        ),
        (
            SshExecError::Interrupted("dropped".into()),
            RemoteOutcome::Unknown("dropped".into()),
        ),
    ] {
        let mut once = Some(error);
        let shell = SshShell::new(FakeLink::answering(move |_| Err(once.take().unwrap())));
        assert_eq!(
            shell.exec(ExecRequest::new(["true"], Duration::ZERO)).await,
            expected
        );
    }

    // A request the script cannot carry never reaches the link.
    let shell = SshShell::new(FakeLink::exits(0));
    assert!(matches!(
        shell.exec(ExecRequest::new(["a\0"], Duration::ZERO)).await,
        RemoteOutcome::NotStarted(ShellError::Refused(_))
    ));
    assert!(shell.link().sent.lock().is_empty());
}

#[tokio::test]
async fn mkdirp_is_mkdir_p_and_a_failure_is_a_refusal() {
    let shell = SshShell::new(FakeLink::exits(0));
    assert_eq!(
        shell.mkdirp("/home/max/.cache/x").await,
        RemoteOutcome::Completed(())
    );
    assert_eq!(
        shell.link().sent.lock()[0].1,
        b"exec 'mkdir' '-p' '--' '/home/max/.cache/x' </dev/null\n"
    );

    let shell = SshShell::new(FakeLink::answering(|_| {
        Ok(output(Some(1), "", "mkdir: Permission denied\n"))
    }));
    assert_eq!(
        shell.mkdirp("/root/x").await,
        RemoteOutcome::NotStarted(ShellError::Refused(
            "mkdir -p failed: mkdir: Permission denied".into()
        ))
    );
}

#[tokio::test]
async fn stat_reads_kind_and_size_over_one_sftp_session() {
    let shell = SshShell::new(FakeLink::exits(0));
    assert_eq!(
        shell.stat("/srv/Alpha.txt").await,
        RemoteOutcome::Completed(Some(RemoteStat {
            is_dir: false,
            size: 5
        }))
    );
    assert_eq!(
        shell.stat("/srv/logs").await,
        RemoteOutcome::Completed(Some(RemoteStat {
            is_dir: true,
            size: 0
        }))
    );
    assert_eq!(
        shell.stat("/srv/absent").await,
        RemoteOutcome::Completed(None)
    );
    assert_eq!(*shell.link().sftp_opened.lock(), 1);

    let mut link = FakeLink::exits(0);
    link.sftp_fails = true;
    assert_eq!(
        SshShell::new(link).stat("/srv").await,
        RemoteOutcome::NotStarted(ShellError::Fault("subsystem refused".into()))
    );
}

#[tokio::test]
async fn an_upload_writes_exactly_the_declared_bytes_over_what_was_there() {
    let shell = SshShell::new(FakeLink::exits(0));
    let archive: Vec<u8> = (0..700_000u32).map(|n| (n % 251) as u8).collect();
    assert_eq!(
        shell.upload("/srv/beta.bin", source(&archive)).await,
        RemoteOutcome::Completed(())
    );
    assert_eq!(
        shell.stat("/srv/beta.bin").await,
        RemoteOutcome::Completed(Some(RemoteStat {
            is_dir: false,
            size: archive.len() as u64
        }))
    );
    let guard = shell.sftp.lock().await;
    let read = guard
        .as_ref()
        .unwrap()
        .read("/srv/beta.bin")
        .await
        .expect("read back");
    assert_eq!(read, archive);
}

#[tokio::test]
async fn an_upload_that_does_not_match_its_declaration_is_unknown() {
    let shell = SshShell::new(FakeLink::exits(0));

    let mut short = source(b"abc");
    short.len = 10;
    assert!(matches!(
        shell.upload("/srv/a", short).await,
        RemoteOutcome::Unknown(detail) if detail.contains("ended after 3 of 10")
    ));

    let mut long = source(b"abcdef");
    long.len = 2;
    assert!(matches!(
        shell.upload("/srv/b", long).await,
        RemoteOutcome::Unknown(detail) if detail.contains("longer than declared")
    ));

    let mut tampered = source(b"abc");
    tampered.sha256 = "0".repeat(64);
    assert!(matches!(
        shell.upload("/srv/c", tampered).await,
        RemoteOutcome::Unknown(detail) if detail.contains("sha256")
    ));
    // A failed upload drops the session; the next step opens a new one.
    assert_eq!(
        shell.stat("/srv").await.map(|s| s.is_some()),
        RemoteOutcome::Completed(true)
    );
    assert_eq!(*shell.link().sftp_opened.lock(), 4);
}
