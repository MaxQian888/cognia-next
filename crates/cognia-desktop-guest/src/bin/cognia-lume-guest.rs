//! Fixed Darwin ingress; user argv is read only from bounded framed stdin.
#[cfg(target_os = "macos")]
#[tokio::main]
async fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    if !valid_arguments(&arguments) {
        std::process::exit(2);
    }
    if arguments[1] == "ssh-ingress" {
        match remote_mode(&std::env::var("SSH_ORIGINAL_COMMAND").unwrap_or_default()) {
            Some("helper") => {}
            Some("driver") => {
                if serve_driver().await.is_err() {
                    std::process::exit(1);
                }
                return;
            }
            _ => std::process::exit(2),
        }
    }
    if serve().await.is_err() {
        std::process::exit(1);
    }
}

#[cfg(target_os = "macos")]
async fn serve_driver() -> Result<(), String> {
    use cognia_desktop_guest::lume::{DriverIdentity, DRIVER_EXECUTABLE, MAX_HEADER};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let mut input = BufReader::new(tokio::io::stdin());
    let mut first = Vec::new();
    let count = (&mut input)
        .take(MAX_HEADER as u64 + 1)
        .read_until(b'\n', &mut first)
        .await
        .map_err(|_| "driver_ingress")?;
    if count == 0 || count > MAX_HEADER {
        return Err("driver_ingress_limit".into());
    }
    let mut initialize: serde_json::Value =
        serde_json::from_slice(&first).map_err(|_| "driver_ingress_schema")?;
    if initialize["method"] != "initialize" {
        return Err("driver_ingress_initialize".into());
    }
    let expected: DriverIdentity = serde_json::from_value(
        initialize["params"]
            .as_object_mut()
            .ok_or("driver_ingress_schema")?
            .remove("cogniaDriverIdentity")
            .ok_or("driver_identity_missing")?,
    )
    .map_err(|_| "driver_identity_invalid")?;
    expected.validate()?;
    if driver_identity().await? != expected {
        return Err("driver_identity_changed".into());
    }
    let mut command = tokio::process::Command::new(DRIVER_EXECUTABLE);
    command
        .arg("mcp")
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "en_US.UTF-8")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(home) = std::env::var_os("HOME") {
        command.env("HOME", home);
    }
    let mut child = command.spawn().map_err(|_| "driver_spawn")?;
    let mut writer = child.stdin.take().ok_or("driver_stdin")?;
    let mut output = BufReader::new(child.stdout.take().ok_or("driver_stdout")?);
    let mut bytes = serde_json::to_vec(&initialize).map_err(|_| "driver_ingress_schema")?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await.map_err(|_| "driver_write")?;
    let incoming = forward_driver_requests(&mut input, &mut writer, &expected, driver_identity);
    let outgoing = async {
        let mut stdout = tokio::io::stdout();
        loop {
            let mut bytes = Vec::new();
            let count = (&mut output)
                .take(12 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut bytes)
                .await
                .map_err(|_| "driver_read")?;
            if count == 0 {
                return Ok::<(), String>(());
            }
            if count > 12 * 1024 * 1024 {
                return Err("driver_reply_limit".into());
            }
            stdout.write_all(&bytes).await.map_err(|_| "driver_write")?;
            stdout.flush().await.map_err(|_| "driver_write")?;
        }
    };
    let result = tokio::select! { result = incoming => result, result = outgoing => result };
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

#[cfg(target_os = "macos")]
async fn forward_driver_requests<R, W, F, Fut>(
    input: &mut tokio::io::BufReader<R>,
    writer: &mut W,
    expected: &cognia_desktop_guest::lume::DriverIdentity,
    observe: F,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<cognia_desktop_guest::lume::DriverIdentity, String>>,
{
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    loop {
        let mut bytes = Vec::new();
        let count = (&mut *input)
            .take(cognia_desktop_guest::lume::MAX_HEADER as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|_| "driver_read")?;
        if count == 0 {
            return Ok(());
        }
        if count > cognia_desktop_guest::lume::MAX_HEADER {
            return Err("driver_ingress_limit".into());
        }
        let _: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "driver_ingress_schema")?;
        if observe().await? != *expected {
            return Err("driver_identity_changed".into());
        }
        writer.write_all(&bytes).await.map_err(|_| "driver_write")?;
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("cognia-lume-guest requires macOS");
    std::process::exit(2);
}

#[cfg(any(target_os = "macos", test))]
fn valid_arguments(arguments: &[String]) -> bool {
    arguments.len() == 2 && matches!(arguments[1].as_str(), "serve-stdio" | "ssh-ingress")
}

#[cfg(any(target_os = "macos", test))]
fn remote_mode(command: &str) -> Option<&'static str> {
    match command {
        "/usr/local/libexec/cognia-lume-guest serve-stdio" => Some("helper"),
        "/usr/local/bin/cua-driver mcp" => Some("driver"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
async fn serve() -> Result<(), String> {
    use cognia_desktop_guest::lume::*;
    use fs2::FileExt;
    use serde::Deserialize;
    use std::{io::Write, path::PathBuf, time::Duration};
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Config {
        instance_nonce: String,
        workspace_root: PathBuf,
    }
    let home = std::env::var_os("HOME").ok_or("guest_home")?;
    let config_path = PathBuf::from(home).join(".config/cognia-lume/guest.json");
    let config: Config =
        serde_json::from_slice(&std::fs::read(&config_path).map_err(|_| "guest_config")?)
            .map_err(|_| "guest_config")?;
    let envelope: Envelope = read_header(&mut std::io::stdin().lock())?;
    if envelope.version != VERSION
        || envelope.instance_nonce != config.instance_nonce
        || envelope.operation_id.len() > 128
        || envelope.boot_epoch.is_empty()
    {
        return Err("guest_identity".into());
    }
    let payload = read_payload(&mut std::io::stdin().lock(), envelope.payload_len)?;
    let result:Result<(serde_json::Value,Vec<u8>),String>=async {
        match envelope.request {
            Request::Hello=>{
                let binary=std::fs::read(std::env::current_exe().map_err(|_|"helper_path")?).map_err(|_|"helper_read")?;
                Ok((serde_json::json!({"version":VERSION,"helperHash":content_hash(&binary),"platform":"darwin","workspaceRoot":config.workspace_root,"vmNetworkEnforcement":false,"strictCpuTreeLimit":false}),vec![]))
            }
            Request::GuiProfile=>Ok((gui_profile().await?,vec![])),
            Request::WorkspaceImport { files }=>{
                let lock=std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(config_path.with_extension("lock")).map_err(|_|"workspace_lock")?;
                lock.lock_exclusive().map_err(|_|"workspace_lock")?;
                import_workspace(&config.workspace_root,&files,&payload)?;
                Ok((serde_json::json!({"imported":files.len()}),vec![]))
            }
            Request::WorkspaceExport=>{
                let lock=std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(config_path.with_extension("lock")).map_err(|_|"workspace_lock")?;
                lock.lock_exclusive().map_err(|_|"workspace_lock")?;
                let (files,body)=export_workspace(&config.workspace_root)?;
                Ok((serde_json::json!({"files":files}),body))
            }
            Request::File {operation}=>{
                let lock=std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(config_path.with_extension("lock")).map_err(|_|"workspace_lock")?;
                lock.lock_exclusive().map_err(|_|"workspace_lock")?;
                file_operation(&config.workspace_root,&operation,&payload)
            }
            Request::Exec{argv,cwd,env,timeout_ms,readable,writable}=>{
                use cognia_exec_sandbox::types::{SandboxCommand,SandboxPolicy,NetworkPolicy};
                if argv.is_empty()||argv.len()>256||timeout_ms==0||timeout_ms>600_000{return Err("exec_limits".into());}
                let root=config.workspace_root.canonicalize().map_err(|_|"workspace_missing")?;
                let resolve=|logical:&str| if logical=="."{Ok(root.clone())}else{workspace_path(&root,logical)};
                let cwd=resolve(&cwd)?;
                let policy=SandboxPolicy::Bash{readable:readable.iter().map(|p|resolve(p)).collect::<Result<Vec<_>,_>>()?,writable:writable.iter().map(|p|resolve(p)).collect::<Result<Vec<_>,_>>()?,network:NetworkPolicy::On,max_cpu_seconds:0,max_memory_mb:0,max_processes:0};
                let command=SandboxCommand{argv,cwd,env,stdin:Some(payload),timeout:Duration::from_millis(timeout_ms)};
                let result=cognia_exec_sandbox::run_confined(command,policy).await.map_err(|_|"exec_refused")?;
                let(stdout,stdout_truncated)=bounded_exec_output(&result.stdout);
                let(stderr,stderr_truncated)=bounded_exec_output(&result.stderr);
                Ok((serde_json::json!({"exitCode":result.exit_code,"stdout":stdout,"stderr":stderr,"durationMs":result.duration.as_millis(),"timedOut":result.timed_out,"stdoutTruncated":result.stdout_truncated||stdout_truncated,"stderrTruncated":result.stderr_truncated||stderr_truncated}),vec![]))
            }
        }
    }.await;
    let (value, payload, error) = match result {
        Ok((value, payload)) => (value, payload, None),
        Err(code) => (serde_json::Value::Null, vec![], Some(code)),
    };
    let reply = Reply {
        version: VERSION,
        operation_id: envelope.operation_id,
        payload_len: payload.len(),
        result: value,
        error_code: error,
    };
    write_frame(&mut std::io::stdout().lock(), &reply, &payload)?;
    std::io::stdout().flush().map_err(|_| "guest_flush".into())
}

#[cfg(target_os = "macos")]
async fn readonly(program: &str, arguments: &[&str]) -> Result<String, String> {
    readonly_output(program, arguments, false).await
}

#[cfg(target_os = "macos")]
async fn readonly_output(
    program: &str,
    arguments: &[&str],
    diagnostic: bool,
) -> Result<String, String> {
    use std::{process::Stdio, time::Duration};
    use tokio::io::AsyncReadExt;
    let mut command = tokio::process::Command::new(program);
    command
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::null())
        .stdout(if diagnostic {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stderr(if diagnostic {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .kill_on_drop(true);
    if let Some(home) = std::env::var_os("HOME") {
        command.env("HOME", home);
    }
    let mut child = command.spawn().map_err(|_| "profile_spawn")?;
    let stdout: Box<dyn tokio::io::AsyncRead + Unpin + Send> = if diagnostic {
        Box::new(child.stderr.take().ok_or("profile_stderr")?)
    } else {
        Box::new(child.stdout.take().ok_or("profile_stdout")?)
    };
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        let mut bytes = Vec::new();
        stdout
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "profile_read")?;
        if bytes.len() > 256 * 1024 {
            return Err("profile_limit");
        }
        if !child.wait().await.map_err(|_| "profile_wait")?.success() {
            return Err("profile_command");
        }
        String::from_utf8(bytes).map_err(|_| "profile_encoding")
    })
    .await
    .map_err(|_| "profile_timeout".to_string())
    .and_then(|result| result.map_err(str::to_string));
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}

#[cfg(target_os = "macos")]
fn live_code_hash(pid: i32) -> Result<String, String> {
    use std::{ffi::c_void, ptr};
    type Cf = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFNumberCreate(allocator: Cf, kind: isize, value: Cf) -> Cf;
        fn CFDictionaryCreate(
            allocator: Cf,
            keys: *const Cf,
            values: *const Cf,
            count: isize,
            key_callbacks: Cf,
            value_callbacks: Cf,
        ) -> Cf;
        fn CFDictionaryGetValue(dictionary: Cf, key: Cf) -> Cf;
        fn CFRelease(value: Cf);
        fn CFGetTypeID(value: Cf) -> usize;
        fn CFDataGetTypeID() -> usize;
        fn CFDataGetLength(value: Cf) -> isize;
        fn CFDataGetBytePtr(value: Cf) -> *const u8;
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;
    }
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        static kSecGuestAttributePid: Cf;
        static kSecCodeInfoUnique: Cf;
        fn SecCodeCopyGuestWithAttributes(
            host: Cf,
            attributes: Cf,
            flags: u32,
            guest: *mut Cf,
        ) -> i32;
        fn SecCodeCheckValidity(code: Cf, flags: u32, requirement: Cf) -> i32;
        fn SecCodeCopySigningInformation(code: Cf, flags: u32, information: *mut Cf) -> i32;
    }
    struct Owned(Cf);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }
    if pid <= 0 {
        return Err("driver_daemon_identity".into());
    }
    let number = Owned(unsafe { CFNumberCreate(ptr::null(), 3, (&pid as *const i32).cast()) });
    if number.0.is_null() {
        return Err("driver_daemon_identity".into());
    }
    let keys = [unsafe { kSecGuestAttributePid }];
    let values = [number.0];
    let attrs = Owned(unsafe {
        CFDictionaryCreate(
            ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
            ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast(),
        )
    });
    if attrs.0.is_null() {
        return Err("driver_daemon_identity".into());
    }
    let mut code = ptr::null();
    if unsafe { SecCodeCopyGuestWithAttributes(ptr::null(), attrs.0, 0, &mut code) } != 0 {
        return Err("driver_daemon_identity".into());
    }
    let code = Owned(code);
    // Check the dynamic Code, not merely its path. Security.framework verifies
    // that the signature on disk matches the image attached to this process.
    if unsafe { SecCodeCheckValidity(code.0, 0, ptr::null()) } != 0 {
        return Err("driver_daemon_identity".into());
    }
    let mut info = ptr::null();
    if unsafe { SecCodeCopySigningInformation(code.0, 2, &mut info) } != 0 {
        return Err("driver_daemon_identity".into());
    }
    let info = Owned(info);
    let hash = unsafe { CFDictionaryGetValue(info.0, kSecCodeInfoUnique) };
    if hash.is_null() || unsafe { CFGetTypeID(hash) != CFDataGetTypeID() } {
        return Err("driver_daemon_identity".into());
    }
    let len = unsafe { CFDataGetLength(hash) };
    let bytes = unsafe { CFDataGetBytePtr(hash) };
    if !matches!(len, 20 | 32) || bytes.is_null() {
        return Err("driver_daemon_identity".into());
    }
    Ok(hex::encode(unsafe {
        std::slice::from_raw_parts(bytes, len as usize)
    }))
}

#[cfg(target_os = "macos")]
async fn driver_identity() -> Result<cognia_desktop_guest::lume::DriverIdentity, String> {
    use cognia_desktop_guest::lume::{DriverIdentity, DRIVER_APP, DRIVER_EXECUTABLE};
    use std::{io::Read, os::fd::AsRawFd, path::Path};
    if Path::new(DRIVER_APP)
        .canonicalize()
        .map_err(|_| "driver_app")?
        != Path::new(DRIVER_APP)
        || Path::new("/usr/local/bin/cua-driver")
            .canonicalize()
            .map_err(|_| "driver_cli")?
            != Path::new(DRIVER_EXECUTABLE)
        || Path::new(DRIVER_EXECUTABLE)
            .canonicalize()
            .map_err(|_| "driver_cli")?
            != Path::new(DRIVER_EXECUTABLE)
    {
        return Err("driver_identity".into());
    }
    readonly(
        "/usr/bin/codesign",
        &["--verify", "--deep", "--strict", DRIVER_APP],
    )
    .await?;
    let mut signature = readonly_output(
        "/usr/bin/codesign",
        &["--display", "--verbose=4", DRIVER_APP],
        true,
    )
    .await?;
    signature.push_str(
        &readonly(
            "/usr/bin/codesign",
            &["--display", "--requirements", "-", DRIVER_APP],
        )
        .await?,
    );
    let home = std::env::var_os("HOME").ok_or("profile_home")?;
    let socket = std::os::unix::net::UnixStream::connect(
        std::path::PathBuf::from(home).join("Library/Caches/cua-driver/cua-driver.sock"),
    )
    .map_err(|_| "driver_daemon")?;
    let (mut uid, mut gid, mut pid) = (0u32, 0u32, 0i32);
    let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
    if unsafe { libc::getpeereid(socket.as_raw_fd(), &mut uid, &mut gid) } != 0
        || uid == 0
        || uid != unsafe { libc::geteuid() }
        || unsafe {
            libc::getsockopt(
                socket.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&mut pid as *mut i32).cast(),
                &mut size,
            )
        } != 0
        || size as usize != std::mem::size_of_val(&pid)
        || pid <= 0
    {
        return Err("driver_daemon_identity".into());
    }
    let mut path = [0u8; 4096];
    if unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) } <= 0 {
        return Err("driver_daemon_identity".into());
    }
    let path = std::ffi::CStr::from_bytes_until_nul(&path)
        .map_err(|_| "driver_daemon_identity")?
        .to_str()
        .map_err(|_| "driver_daemon_identity")?;
    if Path::new(path) != Path::new(DRIVER_EXECUTABLE) {
        return Err("driver_daemon_identity".into());
    }
    use sha2::{Digest, Sha256};
    let file = std::fs::File::open(DRIVER_EXECUTABLE).map_err(|_| "driver_cli")?;
    let mut reader = file.take(512 * 1024 * 1024 + 1);
    let mut digest = Sha256::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 65536];
    loop {
        let count = reader.read(&mut buffer).map_err(|_| "driver_cli")?;
        if count == 0 {
            break;
        }
        total += count;
        if total > 512 * 1024 * 1024 {
            return Err("driver_cli_limit".into());
        }
        digest.update(&buffer[..count]);
    }
    let identity =
        DriverIdentity::from_codesign(&signature, hex::encode(digest.finalize()), pid as u32, uid)?;
    if live_code_hash(pid)? != identity.code_hash {
        return Err("driver_daemon_identity".into());
    }
    Ok(identity)
}

#[cfg(target_os = "macos")]
async fn gui_profile() -> Result<serde_json::Value, String> {
    use std::os::unix::fs::MetadataExt;
    let uid = unsafe { libc::geteuid() };
    let console = std::fs::metadata("/dev/console")
        .map_err(|_| "profile_console")?
        .uid();
    let username = readonly("/usr/bin/id", &["-un"]).await?;
    let autologin = readonly(
        "/usr/bin/defaults",
        &[
            "read",
            "/Library/Preferences/com.apple.loginwindow",
            "autoLoginUser",
        ],
    )
    .await?;
    let filevault = readonly("/usr/bin/fdesetup", &["status"]).await?;
    let identity = driver_identity().await?;
    let permissions: serde_json::Value = serde_json::from_str(
        &readonly(
            cognia_desktop_guest::lume::DRIVER_EXECUTABLE,
            &["permissions", "status", "--json"],
        )
        .await?,
    )
    .map_err(|_| "profile_permissions_schema")?;
    let console_state = readonly("/usr/sbin/ioreg", &["-n", "Root", "-d1", "-l"]).await?;
    let locked = if console_state.contains("\"CGSSessionScreenIsLocked\"=Yes")
        || console_state.contains("\"CGSSessionScreenIsLocked\" = Yes")
    {
        Some(true)
    } else if console_state.contains("\"CGSSessionScreenIsLocked\"=No")
        || console_state.contains("\"CGSSessionScreenIsLocked\" = No")
    {
        Some(false)
    } else {
        None
    };
    let home = std::env::var("HOME").map_err(|_| "profile_home")?;
    let agent = format!("{home}/Library/LaunchAgents/com.cognia.lume.driver.plist");
    let launch_agent: serde_json::Value = serde_json::from_str(
        &readonly("/usr/bin/plutil", &["-convert", "json", "-o", "-", &agent]).await?,
    )
    .map_err(|_| "profile_launch_agent")?;
    let auto_launch = launch_agent["Label"] == "com.cognia.lume.driver"
        && launch_agent["RunAtLoad"] == true
        && launch_agent["ProgramArguments"]
            == serde_json::json!(["/usr/bin/open", "-a", "/Applications/CuaDriver.app"]);
    Ok(
        serde_json::json!({"consoleUidMatches":uid!=0&&uid==console,"autoLoginMatches":username.trim()==autologin.trim(),"fileVaultOff":filevault.contains("FileVault is Off"),"locked":locked,"autoLaunch":auto_launch,"permissions":permissions,"driverIdentity":identity}),
    )
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn driver_relay_refuses_identity_change_before_forwarding_a_queued_input() {
        let signing = format!("Identifier=com.trycua.driver\nTeamIdentifier=TEAM123456\nCDHash={}\ndesignated => identifier \"com.trycua.driver\" and anchor apple generic\n", "a".repeat(40));
        let expected = cognia_desktop_guest::lume::DriverIdentity::from_codesign(
            &signing,
            "b".repeat(64),
            42,
            501,
        )
        .unwrap();
        let mut changed = expected.clone();
        changed.executable_hash = "c".repeat(64);
        let request = b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"click\"}}\n";
        let mut input = tokio::io::BufReader::new(&request[..]);
        let mut output = Vec::new();
        assert_eq!(
            super::forward_driver_requests(&mut input, &mut output, &expected, || {
                std::future::ready(Ok(changed.clone()))
            })
            .await
            .unwrap_err(),
            "driver_identity_changed"
        );
        assert!(output.is_empty());
        let mut input = tokio::io::BufReader::new(&request[..]);
        super::forward_driver_requests(&mut input, &mut output, &expected, || {
            std::future::ready(Ok(expected.clone()))
        })
        .await
        .unwrap();
        assert_eq!(output, request);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn live_code_identity_rejects_a_replaced_executable_at_the_same_path() {
        let root =
            std::env::temp_dir().join(format!("cognia-driver-identity-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("peer");
        std::fs::copy("/bin/sleep", &path).unwrap();
        assert!(std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(&path)
            .status()
            .unwrap()
            .success());
        struct Peer(std::process::Child);
        impl Drop for Peer {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = Peer(std::process::Command::new(&path).arg("20").spawn().unwrap());
        {
            std::thread::sleep(std::time::Duration::from_millis(30));
            let original = super::live_code_hash(child.0.id() as i32).unwrap();
            assert!(!original.is_empty());
            std::fs::copy("/usr/bin/true", root.join("replacement")).unwrap();
            std::fs::rename(root.join("replacement"), &path).unwrap();
            let replaced = super::live_code_hash(child.0.id() as i32);
            assert!(replaced.is_err() || replaced.as_ref().is_ok_and(|value| value == &original));
            // It must never report the replacement's on-disk CDHash as the
            // still-running peer's identity.
        }
        drop(child);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn entrypoint_has_no_user_command_argument_mode() {
        assert!(super::valid_arguments(&[
            "helper".into(),
            "serve-stdio".into()
        ]));
        assert!(!super::valid_arguments(&[
            "helper".into(),
            "serve-stdio".into(),
            "sh".into()
        ]));
        assert!(super::valid_arguments(&[
            "helper".into(),
            "ssh-ingress".into()
        ]));
        assert_eq!(
            super::remote_mode("/usr/local/bin/cua-driver mcp"),
            Some("driver")
        );
        assert_eq!(
            super::remote_mode("/usr/local/libexec/cognia-lume-guest serve-stdio"),
            Some("helper")
        );
        for command in [
            "sh",
            "/usr/local/bin/cua-driver mcp; touch /tmp/host",
            "/usr/local/libexec/cognia-lume-guest serve-stdio extra",
        ] {
            assert!(super::remote_mode(command).is_none());
        }
    }
}
