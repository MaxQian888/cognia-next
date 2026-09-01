//! Serial / COM port monitor.
//!
//! The Rust half of `lib/terminal/serial/`, which has been calling these five
//! commands since it was written and getting a dispatch error every time. The
//! TypeScript side already fixes the wire shape (`SerialConfig`,
//! `SerialPortInfo`, `SerialConnectionStatus`) and its formatters and
//! validators are unit-tested, so this implements that contract rather than
//! proposing a new one. The argument spellings below are the ones
//! `serial-connection.ts` actually sends, snake_case inside `config` and
//! `session_id` in the open result, and they are load-bearing.
//!
//! ## Why not a PTY session
//!
//! A serial port is a byte stream, which is what `PtySession` carries, and
//! reusing it would have brought replay and reattach for free. It is not one:
//! there is no child process, no exit status, no window size, and closing the
//! port is not killing anything. The host session protocol is built around
//! those four, so a serial "session" would have had to answer them with
//! placeholders. This registry is deliberately small instead, and the read
//! loop pushes bytes out on the same per-handle event topic
//! `crates/cognia-connectors/src/ws_client.rs` uses for its sockets.
//!
//! ## Bytes on the wire
//!
//! Inbound data is base64 rather than a JSON number array. A `Vec<u8>` through
//! `serde_json` becomes one decimal number plus a comma per byte, roughly a 4x
//! expansion, and a 115200-baud device saturates that. Base64 costs 33% and
//! the renderer already decodes it for attachments.
//!
//! ## What is deliberately absent
//!
//! Nothing here opens a port on its own. A port is a physical device that may
//! be a router console, a programmer, or an industrial controller, and writing
//! a stray byte to one can be destructive, so every open is a user action
//! carrying a port the user picked. The agent tool surface does not reach this
//! module at all.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_serial::SerialPortBuilderExt;
use uuid::Uuid;

/// Read buffer for one poll. Large enough that a fast device does not produce
/// an event per byte, small enough that a slow one still feels live.
const READ_CHUNK: usize = 4096;

/// How long a write may block before the caller is told the device is not
/// draining. Serial flow control can stall indefinitely with hardware
/// handshaking and nothing on the other end.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// Where a session's inbound bytes and status changes are published.
///
/// One implementation per host: the desktop emits a Tauri event, and tests
/// record. Deliberately a local trait rather than a dependency on
/// `cognia-connectors`' `EventEmitter`, which would drag the whole connector
/// crate in for one method.
pub trait SerialEventSink: Send + Sync + 'static {
    fn emit(&self, topic: &str, payload: serde_json::Value);
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SerialConfig {
    pub port: String,
    pub baud_rate: u32,
    /// 5 | 6 | 7 | 8.
    pub data_bits: u8,
    /// `none` | `odd` | `even` | `mark` | `space`.
    pub parity: String,
    /// 1 | 1.5 | 2. Carried as a float because the TypeScript union includes
    /// 1.5, which no serial API implements. See [`stop_bits`].
    pub stop_bits: f64,
    /// `none` | `hardware` | `software`.
    pub flow_control: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub path: String,
    /// `usb` | `bluetooth` | `pci` | `unknown`.
    pub port_type: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    /// Lowercase hex, no `0x`, four digits.
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
}

/// The open result. `session_id` is snake_case because that is the key
/// `lib/terminal/serial/serial-connection.ts` reads.
#[derive(Debug, Clone, Serialize)]
pub struct SerialOpenResult {
    pub session_id: String,
}

/// Outbound bytes plus the channel the loop answers on.
///
/// The ack is what makes [`write_serial`] mean "the device took these bytes"
/// rather than "these bytes are in a queue". Without it a write that was still
/// sitting in the channel when the cable was pulled reported success, and
/// `writeSerialPort` turns that into a `true` the composer shows as sent.
type WriteRequest = (Vec<u8>, tokio::sync::oneshot::Sender<Result<(), String>>);

struct SerialSession {
    /// Outbound bytes. A channel rather than a shared writer so a slow device
    /// cannot hold a lock the status read also wants.
    writer: mpsc::Sender<WriteRequest>,
    status: Arc<Mutex<&'static str>>,
    /// Released by [`attach_serial`], which is what lets the read loop start.
    /// `None` once a caller has attached, so a second attach is a no-op rather
    /// than a panic.
    attach: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Dropping this aborts the read loop, which closes the port.
    _guard: Arc<ReadGuard>,
}

/// Aborts the reader on drop. The abort is what actually closes the port: the
/// `SerialStream` is owned by that task and nothing else holds it.
struct ReadGuard(tokio::task::AbortHandle);

impl Drop for ReadGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Default)]
struct Registry {
    sessions: Mutex<HashMap<String, SerialSession>>,
}

fn registry() -> &'static Registry {
    static REGISTRY: once_cell::sync::Lazy<Registry> =
        once_cell::sync::Lazy::new(Registry::default);
    &REGISTRY
}

/// `terminal://serial/<id>/data`, carrying `{ "base64": "..." }`.
pub fn data_topic(session_id: &str) -> String {
    format!("terminal://serial/{session_id}/data")
}

/// `terminal://serial/<id>/status`, carrying `{ "status": "...", "reason": ... }`.
pub fn status_topic(session_id: &str) -> String {
    format!("terminal://serial/{session_id}/status")
}

/// Map the TypeScript vocabulary onto `tokio_serial`'s enums.
///
/// Every one of these is exhaustive over the union in
/// `lib/terminal/serial/types.ts` and falls back to the value that union
/// declares as its default, so an unrecognised string opens a working port
/// rather than failing. The alternative, refusing, turns a renderer typo into
/// "your device is broken".
fn data_bits(value: u8) -> tokio_serial::DataBits {
    match value {
        5 => tokio_serial::DataBits::Five,
        6 => tokio_serial::DataBits::Six,
        7 => tokio_serial::DataBits::Seven,
        _ => tokio_serial::DataBits::Eight,
    }
}

fn parity(value: &str) -> tokio_serial::Parity {
    match value {
        "odd" => tokio_serial::Parity::Odd,
        "even" => tokio_serial::Parity::Even,
        // `mark` and `space` are in the TypeScript union because RS-232 defines
        // them, but neither Windows' DCB-backed driver nor termios exposes them
        // through this crate. They degrade to `none`, which is what a device
        // expecting a mark bit will report as a framing error, rather than
        // silently sending even parity and looking like corrupt data.
        _ => tokio_serial::Parity::None,
    }
}

/// 1.5 stop bits exists on paper and in the TypeScript union, and on no serial
/// API this crate can reach. It rounds UP to two: a receiver configured for 1.5
/// tolerates a longer idle between frames, while rounding down would cut the
/// stop period short and frame-error every byte.
fn stop_bits(value: f64) -> tokio_serial::StopBits {
    if value >= 1.5 {
        tokio_serial::StopBits::Two
    } else {
        tokio_serial::StopBits::One
    }
}

fn flow_control(value: &str) -> tokio_serial::FlowControl {
    match value {
        "hardware" => tokio_serial::FlowControl::Hardware,
        "software" => tokio_serial::FlowControl::Software,
        _ => tokio_serial::FlowControl::None,
    }
}

/// Every serial port the OS reports.
///
/// On Linux this is a sysfs scan without USB metadata, because the crate's
/// `libudev` feature is off (see `Cargo.toml`). The fields come back `None`
/// there rather than as empty strings, so a caller can tell "this device has
/// no vendor id" from "this host cannot read one".
pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = tokio_serial::available_ports().map_err(|error| error.to_string())?;
    Ok(ports
        .into_iter()
        .filter(|port| is_offerable(&port.port_name))
        .map(describe_port)
        .collect())
}

/// Whether a device node is one a user can safely be offered.
///
/// macOS exposes every serial device twice, as `/dev/tty.X` and `/dev/cu.X`.
/// They are not aliases. Opening the `tty` node BLOCKS until the device
/// asserts carrier detect, which for a USB adapter with nothing plugged into
/// its far end is forever, and the block happens inside `open(2)` where no
/// timeout reaches it. The `cu` ("call-up") node is the one that opens
/// immediately. Listing both would put a port in the picker that hangs the app
/// when chosen, and the two entries look identical to a user.
fn is_offerable(port_name: &str) -> bool {
    !(cfg!(target_os = "macos") && port_name.starts_with("/dev/tty."))
}

fn describe_port(port: tokio_serial::SerialPortInfo) -> SerialPortInfo {
    let path = port.port_name;
    match port.port_type {
        tokio_serial::SerialPortType::UsbPort(usb) => SerialPortInfo {
            path,
            port_type: "usb".to_string(),
            manufacturer: usb.manufacturer,
            product: usb.product,
            serial_number: usb.serial_number,
            vendor_id: Some(format!("{:04x}", usb.vid)),
            product_id: Some(format!("{:04x}", usb.pid)),
        },
        tokio_serial::SerialPortType::BluetoothPort => SerialPortInfo {
            path,
            port_type: "bluetooth".to_string(),
            manufacturer: None,
            product: None,
            serial_number: None,
            vendor_id: None,
            product_id: None,
        },
        tokio_serial::SerialPortType::PciPort => SerialPortInfo {
            path,
            port_type: "pci".to_string(),
            manufacturer: None,
            product: None,
            serial_number: None,
            vendor_id: None,
            product_id: None,
        },
        tokio_serial::SerialPortType::Unknown => SerialPortInfo {
            path,
            port_type: "unknown".to_string(),
            manufacturer: None,
            product: None,
            serial_number: None,
            vendor_id: None,
            product_id: None,
        },
    }
}

/// Open `config.port` and start streaming its bytes to `sink`.
///
/// Returns the session id the four other commands address. The port stays open
/// until [`close_serial`] or until the device disappears, which the read loop
/// reports as `error` rather than `disconnected`: a cable pulled mid-transfer
/// is not the same event as a user closing the monitor, and only the first one
/// means unsent bytes were lost.
pub async fn open_serial(
    config: SerialConfig,
    sink: Arc<dyn SerialEventSink>,
) -> Result<SerialOpenResult, String> {
    let stream = tokio_serial::new(&config.port, config.baud_rate)
        .data_bits(data_bits(config.data_bits))
        .parity(parity(&config.parity))
        .stop_bits(stop_bits(config.stop_bits))
        .flow_control(flow_control(&config.flow_control))
        .open_native_async()
        .map_err(|error| format!("open {}: {error}", config.port))?;

    let session_id = Uuid::new_v4().to_string();
    let status = Arc::new(Mutex::new("connected"));
    let (writer_tx, mut writer_rx) = mpsc::channel::<WriteRequest>(64);
    let (attach_tx, attach_rx) = tokio::sync::oneshot::channel::<()>();

    let task_id = session_id.clone();
    let task_status = Arc::clone(&status);
    let task_sink = Arc::clone(&sink);
    let handle = tokio::spawn(async move {
        // Nothing is read until a caller attaches. The renderer cannot
        // subscribe to the two topics until `open_serial` has returned it a
        // session id, so a loop that started here would emit into a void: a
        // bootloader that greets on open lost its banner, and a port that died
        // in that window left a session the UI still believed was connected.
        // `Err` means the session was closed before anyone attached.
        if attach_rx.await.is_err() {
            return;
        }
        let mut stream = stream;
        let mut buffer = vec![0u8; READ_CHUNK];
        loop {
            // Deliberately NOT `biased`. Polling the write branch first meant a
            // caller that kept the 64-slot queue full could starve the read
            // branch indefinitely, and because the selected branch runs its
            // `write_all` to completion, inbound bytes piled up in the kernel
            // buffer and a hot-unplug went unnoticed until the writes drained.
            // Random selection lets both sides make progress.
            tokio::select! {
                outbound = writer_rx.recv() => {
                    let Some((bytes, ack)) = outbound else { break };
                    match tokio::time::timeout(WRITE_TIMEOUT, stream.write_all(&bytes)).await {
                        Ok(Ok(())) => {
                            // A serial write is only durable once it has been
                            // handed to the driver, which `write_all` returning
                            // Ok is. `flush` on a `SerialStream` is a no-op.
                            let _ = ack.send(Ok(()));
                        }
                        Ok(Err(error)) => {
                            let reason = error.to_string();
                            let _ = ack.send(Err(reason.clone()));
                            fail(&task_sink, &task_id, &task_status, &reason);
                            break
                        }
                        Err(_) => {
                            let reason =
                                "the device did not accept the write within 5s (flow control?)";
                            let _ = ack.send(Err(reason.to_string()));
                            fail(&task_sink, &task_id, &task_status, reason);
                            break
                        }
                    }
                }
                read = stream.read(&mut buffer) => match read {
                    // A serial port reports EOF when the device goes away. It
                    // is not an idle stream, so the loop must end rather than
                    // spin on a closed descriptor.
                    Ok(0) => {
                        fail(&task_sink, &task_id, &task_status, "the device closed the port");
                        break
                    }
                    Ok(count) => {
                        use base64::Engine as _;
                        let encoded = base64::engine::general_purpose::STANDARD
                            .encode(&buffer[..count]);
                        task_sink.emit(
                            &data_topic(&task_id),
                            serde_json::json!({ "base64": encoded }),
                        );
                    }
                    Err(error) => {
                        fail(&task_sink, &task_id, &task_status, &error.to_string());
                        break
                    }
                }
            }
        }
        // The loop only ends when the port is gone, so the entry describes a
        // session that can no longer read or write. Leaving it behind held the
        // sender, the sink and an `AbortHandle` for the life of the process,
        // one set per hot-unplug. The renderer already has the `error` status
        // event; `serial_status` answering `disconnected` afterwards is the
        // truthful reading of an id that names nothing.
        let removed = registry().sessions.lock().remove(&task_id);
        drop(removed);
    });

    registry().sessions.lock().insert(
        session_id.clone(),
        SerialSession {
            writer: writer_tx,
            status,
            attach: Mutex::new(Some(attach_tx)),
            _guard: Arc::new(ReadGuard(handle.abort_handle())),
        },
    );
    Ok(SerialOpenResult { session_id })
}

/// Start streaming, now that the caller is listening.
///
/// Split from [`open_serial`] because the renderer can only subscribe to
/// `terminal://serial/<id>/...` once it holds the id, and Tauri events are not
/// buffered: anything emitted in that window is simply gone. Opening and
/// reading are therefore two steps, and the port sits idle but open between
/// them. `false` when the id names nothing.
///
/// Idempotent. A second attach finds the gate already spent and does nothing,
/// so a reconnecting renderer cannot restart a loop that is already running.
///
/// A write issued before the attach queues rather than failing, and its ack
/// arrives once the loop starts. In practice `SerialTerminalSession.open`
/// attaches before it hands the session to anyone, so nothing can write first.
pub fn attach_serial(session_id: &str) -> bool {
    let gate = {
        let sessions = registry().sessions.lock();
        let Some(session) = sessions.get(session_id) else {
            return false;
        };
        let gate = session.attach.lock().take();
        gate
    };
    match gate {
        Some(gate) => {
            let _ = gate.send(());
            true
        }
        // Already attached. Still `true`: the session exists and is streaming.
        None => true,
    }
}

fn fail(
    sink: &Arc<dyn SerialEventSink>,
    session_id: &str,
    status: &Arc<Mutex<&'static str>>,
    reason: &str,
) {
    *status.lock() = "error";
    sink.emit(
        &status_topic(session_id),
        serde_json::json!({ "status": "error", "reason": reason }),
    );
}

/// Close a session. `false` when the id names nothing, which is not an error:
/// a renderer reload and a device unplug both leave a caller holding a stale
/// id, and both should close quietly.
pub fn close_serial(session_id: &str) -> bool {
    registry().sessions.lock().remove(session_id).is_some()
}

/// Queue `data` for the device.
///
/// Fails when the id is unknown or the reader has stopped, because a write
/// that goes nowhere must not look like a write that landed. Bytes are taken
/// verbatim: the line ending is the renderer's decision and it has already
/// appended one.
pub async fn write_serial(session_id: &str, data: &str) -> Result<(), String> {
    let writer = {
        let sessions = registry().sessions.lock();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("no serial session {session_id}"))?;
        session.writer.clone()
    };
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
    writer
        .send((data.as_bytes().to_vec(), ack_tx))
        .await
        .map_err(|_| format!("serial session {session_id} is no longer reading"))?;
    // Waiting for the ack is the point: returning at the queue boundary made a
    // write that the cable never carried indistinguishable from one it did.
    // The wait is bounded by WRITE_TIMEOUT inside the loop.
    ack_rx
        .await
        .map_err(|_| format!("serial session {session_id} stopped before the write landed"))?
}

/// `disconnected` | `connected` | `error`.
///
/// `connecting` is in the TypeScript union and never returned here: the open
/// call is awaited, so by the time a caller holds an id the port is either open
/// or the open failed. The renderer owns that state while its own call is in
/// flight.
pub fn serial_status(session_id: &str) -> &'static str {
    registry()
        .sessions
        .lock()
        .get(session_id)
        .map(|session| *session.status.lock())
        .unwrap_or("disconnected")
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Publishes onto the desktop event bus, one topic per session, the same shape
/// `connectors://ws/<id>/message` uses.
struct AppHandleSink<R: tauri::Runtime>(tauri::AppHandle<R>);

impl<R: tauri::Runtime> SerialEventSink for AppHandleSink<R> {
    fn emit(&self, topic: &str, payload: serde_json::Value) {
        use tauri::Emitter as _;
        let _ = self.0.emit(topic, payload);
    }
}

#[tauri::command]
pub async fn terminal_list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    // Enumeration walks the OS device tree, so it stays off the async runtime.
    tokio::task::spawn_blocking(list_serial_ports)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn terminal_open_serial<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    config: SerialConfig,
) -> Result<SerialOpenResult, String> {
    open_serial(config, Arc::new(AppHandleSink(app))).await
}

#[tauri::command]
pub async fn terminal_close_serial(session_id: String) -> Result<(), String> {
    close_serial(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn terminal_serial_write(session_id: String, data: String) -> Result<(), String> {
    write_serial(&session_id, &data).await
}

#[tauri::command]
pub async fn terminal_serial_attach(session_id: String) -> Result<bool, String> {
    Ok(attach_serial(&session_id))
}

#[tauri::command]
pub async fn terminal_serial_status(session_id: String) -> Result<&'static str, String> {
    Ok(serial_status(&session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_bits_cover_the_union_and_default_to_eight() {
        assert_eq!(data_bits(5), tokio_serial::DataBits::Five);
        assert_eq!(data_bits(7), tokio_serial::DataBits::Seven);
        assert_eq!(data_bits(8), tokio_serial::DataBits::Eight);
        // Not in the union at all. Opening at 8N1 beats refusing.
        assert_eq!(data_bits(99), tokio_serial::DataBits::Eight);
    }

    /// `mark` and `space` are real RS-232 parities and unreachable through this
    /// crate. They must land on `None` rather than on `Even`, which would send
    /// wrong bits that look like data corruption instead of a framing error.
    #[test]
    fn unsupported_parities_fall_back_to_none() {
        assert_eq!(parity("odd"), tokio_serial::Parity::Odd);
        assert_eq!(parity("even"), tokio_serial::Parity::Even);
        assert_eq!(parity("mark"), tokio_serial::Parity::None);
        assert_eq!(parity("space"), tokio_serial::Parity::None);
        assert_eq!(parity("none"), tokio_serial::Parity::None);
    }

    /// Rounding 1.5 down would cut the stop period short and frame-error every
    /// byte. Rounding up only lengthens an idle the receiver tolerates.
    #[test]
    fn one_and_a_half_stop_bits_round_up() {
        assert_eq!(stop_bits(1.0), tokio_serial::StopBits::One);
        assert_eq!(stop_bits(1.5), tokio_serial::StopBits::Two);
        assert_eq!(stop_bits(2.0), tokio_serial::StopBits::Two);
    }

    #[test]
    fn flow_control_covers_the_union() {
        assert_eq!(
            flow_control("hardware"),
            tokio_serial::FlowControl::Hardware
        );
        assert_eq!(
            flow_control("software"),
            tokio_serial::FlowControl::Software
        );
        assert_eq!(flow_control("none"), tokio_serial::FlowControl::None);
        assert_eq!(flow_control("nonsense"), tokio_serial::FlowControl::None);
    }

    #[test]
    fn usb_metadata_is_reported_as_lowercase_four_digit_hex() {
        let described = describe_port(tokio_serial::SerialPortInfo {
            port_name: "/dev/cu.usbserial-1420".to_string(),
            port_type: tokio_serial::SerialPortType::UsbPort(tokio_serial::UsbPortInfo {
                vid: 0x1a86,
                pid: 0x7523,
                serial_number: Some("SN1".to_string()),
                manufacturer: Some("QinHeng".to_string()),
                product: Some("CH340".to_string()),
            }),
        });
        assert_eq!(described.port_type, "usb");
        assert_eq!(described.vendor_id.as_deref(), Some("1a86"));
        assert_eq!(described.product_id.as_deref(), Some("7523"));
        assert_eq!(described.product.as_deref(), Some("CH340"));
    }

    /// `None` rather than `Some("")`: a caller must be able to tell "this
    /// device has no vendor id" from "this host cannot read one".
    #[test]
    fn a_non_usb_port_reports_absent_metadata_rather_than_blanks() {
        let described = describe_port(tokio_serial::SerialPortInfo {
            port_name: "/dev/ttyS0".to_string(),
            port_type: tokio_serial::SerialPortType::PciPort,
        });
        assert_eq!(described.port_type, "pci");
        assert!(described.vendor_id.is_none());
        assert!(described.manufacturer.is_none());
    }

    #[test]
    fn an_unknown_session_is_disconnected_and_closing_it_is_quiet() {
        assert_eq!(serial_status("no-such-session"), "disconnected");
        assert!(!close_serial("no-such-session"));
    }

    /// A write to a session that never existed must fail rather than resolve.
    /// The renderer's `writeSerialPort` returns a boolean, and a silent success
    /// there is a message the user believes they sent.
    #[tokio::test]
    async fn writing_to_an_unknown_session_fails() {
        let error = write_serial("no-such-session", "AT\r\n")
            .await
            .expect_err("must not resolve");
        assert!(error.contains("no serial session"));
    }

    /// macOS's `tty` node blocks in `open(2)` until carrier detect. Offering
    /// it puts a port in the picker that hangs the app when chosen, next to a
    /// `cu` entry that looks identical.
    #[test]
    fn macos_offers_the_call_up_node_and_not_its_blocking_twin() {
        assert!(is_offerable("/dev/cu.usbserial-1420"));
        assert_eq!(
            is_offerable("/dev/tty.usbserial-1420"),
            !cfg!(target_os = "macos")
        );
        // Linux and Windows have no such pair, so nothing is filtered there.
        assert!(is_offerable("/dev/ttyUSB0"));
        assert!(is_offerable("COM3"));
    }

    /// Runs against whatever this machine has. Asserts shape rather than
    /// content: a CI box with no serial hardware is a valid empty list, and a
    /// developer laptop reporting its Bluetooth and debug consoles is a valid
    /// non-empty one.
    #[test]
    fn enumeration_returns_well_formed_entries_or_nothing() {
        let ports = list_serial_ports().expect("enumeration must not error");
        for port in &ports {
            assert!(!port.path.is_empty());
            assert!(["usb", "bluetooth", "pci", "unknown"].contains(&port.port_type.as_str()));
            assert!(is_offerable(&port.path));
            for hex in [&port.vendor_id, &port.product_id] {
                if let Some(hex) = hex {
                    assert_eq!(hex.len(), 4, "{hex} is not four hex digits");
                    assert!(hex
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
                }
            }
        }
    }

    #[test]
    fn topics_are_namespaced_per_session() {
        assert_eq!(data_topic("abc"), "terminal://serial/abc/data");
        assert_eq!(status_topic("abc"), "terminal://serial/abc/status");
    }

    /// Registers a session shaped like a real one, without a port: an attach
    /// gate, a write channel, and a parked task holding the abort handle. Every
    /// registry-lifecycle rule below is about those three and not about the
    /// hardware, so this exercises them on a machine with no serial devices.
    fn register_fake_session(id: &str) -> (mpsc::Receiver<WriteRequest>, Arc<Mutex<&'static str>>) {
        let (writer_tx, writer_rx) = mpsc::channel::<WriteRequest>(4);
        let (attach_tx, attach_rx) = tokio::sync::oneshot::channel::<()>();
        let status = Arc::new(Mutex::new("connected"));
        let handle = tokio::spawn(async move {
            let _ = attach_rx.await;
            std::future::pending::<()>().await;
        });
        registry().sessions.lock().insert(
            id.to_string(),
            SerialSession {
                writer: writer_tx,
                status: Arc::clone(&status),
                attach: Mutex::new(Some(attach_tx)),
                _guard: Arc::new(ReadGuard(handle.abort_handle())),
            },
        );
        (writer_rx, status)
    }

    /// The renderer cannot subscribe before it holds the id, so the read loop
    /// must not start until it says so. Attaching twice is what a reconnecting
    /// renderer does, and it must not restart or panic.
    #[tokio::test]
    async fn attaching_releases_the_gate_once_and_tolerates_a_second_call() {
        assert!(!attach_serial("no-such-session"));

        let id = "attach-test";
        let (_rx, _status) = register_fake_session(id);
        assert!(attach_serial(id));
        // The gate is spent. Still `true`: the session exists and is streaming.
        assert!(attach_serial(id));
        assert!(close_serial(id));
    }

    /// A write is acknowledged by the loop, not by the queue. When the loop is
    /// gone the ack sender is dropped, and that must surface as an error rather
    /// than as a resolved write the composer renders as sent.
    #[tokio::test]
    async fn a_write_whose_reader_vanished_reports_the_loss() {
        let id = "write-ack-test";
        let (rx, _status) = register_fake_session(id);
        // Dropping the receiver is what a stopped loop looks like from here.
        drop(rx);
        let error = write_serial(id, "AT\r\n")
            .await
            .expect_err("a write nobody can take must not resolve");
        assert!(error.contains("no longer reading"), "{error}");
        assert!(close_serial(id));
    }

    /// The loop answers the ack, and only then does the caller return.
    #[tokio::test]
    async fn a_write_resolves_on_the_acknowledgement_the_loop_sends() {
        let id = "write-ok-test";
        let (mut rx, _status) = register_fake_session(id);
        let write = tokio::spawn(async move { write_serial("write-ok-test", "AT\r\n").await });
        let (bytes, ack) = rx.recv().await.expect("the write must reach the loop");
        assert_eq!(bytes, b"AT\r\n".to_vec());
        ack.send(Ok(())).expect("the caller must still be waiting");
        write.await.expect("join").expect("the write must resolve");
        assert!(close_serial(id));
    }

    /// Closing drops the session, which drops the `ReadGuard` and aborts the
    /// task that owns the `SerialStream`. A second close names nothing.
    #[tokio::test]
    async fn closing_removes_the_entry_and_is_idempotent() {
        let id = "close-test";
        let (_rx, _status) = register_fake_session(id);
        assert_eq!(serial_status(id), "connected");
        assert!(close_serial(id));
        assert_eq!(serial_status(id), "disconnected");
        assert!(!close_serial(id));
    }
}
