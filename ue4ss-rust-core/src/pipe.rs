use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

static CONNECTED: AtomicBool = AtomicBool::new(false);
static LAST_ERROR: AtomicU32 = AtomicU32::new(0);
static COMMAND_LAST_ERROR: AtomicU32 = AtomicU32::new(0);

const EVENT_QUEUE_MAX_LEN: usize = 4096;
const EVENT_QUEUE_MAX_BYTES: usize = 4 * 1024 * 1024;
const EVENT_RETRY_INTERVAL_MS: u64 = 50;

fn port_file_path() -> std::path::PathBuf {
    std::env::temp_dir().join("kovaaks-bridge.port")
}

fn event_stream() -> &'static Mutex<Option<TcpStream>> {
    static STREAM: OnceLock<Mutex<Option<TcpStream>>> = OnceLock::new();
    STREAM.get_or_init(|| Mutex::new(None))
}

fn cmd_stream() -> &'static Mutex<Option<TcpStream>> {
    static STREAM: OnceLock<Mutex<Option<TcpStream>>> = OnceLock::new();
    STREAM.get_or_init(|| Mutex::new(None))
}

fn command_buffer() -> &'static Mutex<Vec<u8>> {
    static BUFFER: OnceLock<Mutex<Vec<u8>>> = OnceLock::new();
    BUFFER.get_or_init(|| Mutex::new(Vec::with_capacity(4096)))
}

struct EventQueueState {
    queue: VecDeque<String>,
    queued_bytes: usize,
    stop: bool,
}

struct EventQueue {
    state: Mutex<EventQueueState>,
    wake: Condvar,
    worker: Mutex<Option<JoinHandle<()>>>,
}

fn event_queue() -> &'static EventQueue {
    static QUEUE: OnceLock<EventQueue> = OnceLock::new();
    QUEUE.get_or_init(|| EventQueue {
        state: Mutex::new(EventQueueState {
            queue: VecDeque::new(),
            queued_bytes: 0,
            stop: false,
        }),
        wake: Condvar::new(),
        worker: Mutex::new(None),
    })
}

fn close_streams() {
    CONNECTED.store(false, Ordering::Release);
    if let Ok(mut guard) = event_stream().lock() {
        if let Some(ref s) = *guard {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
        *guard = None;
    }
    if let Ok(mut guard) = cmd_stream().lock() {
        if let Some(ref s) = *guard {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
        *guard = None;
    }
    if let Ok(mut buf) = command_buffer().lock() {
        buf.clear();
    }
}

fn write_event_now(json: &str) -> bool {
    let mut line = String::with_capacity(json.len() + 1);
    line.push_str(json);
    line.push('\n');

    // Scope the lock guard so it's dropped before close_streams() acquires it.
    let write_result: Result<(), u32> = {
        let Ok(mut guard) = event_stream().lock() else {
            return false;
        };
        let Some(ref mut stream) = *guard else {
            CONNECTED.store(false, Ordering::Release);
            return false;
        };
        stream
            .write_all(line.as_bytes())
            .map_err(|e| e.raw_os_error().unwrap_or(0) as u32)
        // guard dropped here
    };

    match write_result {
        Ok(_) => true,
        Err(code) => {
            LAST_ERROR.store(code, Ordering::Release);
            close_streams();
            false
        }
    }
}

fn ensure_event_worker() {
    let queue = event_queue();
    let mut worker = queue.worker.lock().unwrap_or_else(|err| err.into_inner());
    if worker.is_some() {
        return;
    }
    {
        let mut state = queue.state.lock().unwrap_or_else(|err| err.into_inner());
        state.stop = false;
    }
    *worker = Some(thread::spawn(event_worker_loop));
}

fn stop_event_worker() {
    let queue = event_queue();
    {
        let mut state = queue.state.lock().unwrap_or_else(|err| err.into_inner());
        state.stop = true;
        state.queue.clear();
        state.queued_bytes = 0;
        queue.wake.notify_all();
    }

    close_streams();

    let worker = queue
        .worker
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .take();
    if let Some(worker) = worker {
        let _ = worker.join();
    }
}

fn requeue_event_front(payload: String) {
    let queue = event_queue();
    let mut state = queue.state.lock().unwrap_or_else(|err| err.into_inner());
    if state.stop {
        return;
    }

    let payload_len = payload.len();
    while (state.queue.len() >= EVENT_QUEUE_MAX_LEN
        || state.queued_bytes.saturating_add(payload_len) > EVENT_QUEUE_MAX_BYTES)
        && !state.queue.is_empty()
    {
        if let Some(dropped) = state.queue.pop_back() {
            state.queued_bytes = state.queued_bytes.saturating_sub(dropped.len());
        }
    }

    if state.queue.len() >= EVENT_QUEUE_MAX_LEN
        || state.queued_bytes.saturating_add(payload_len) > EVENT_QUEUE_MAX_BYTES
    {
        return;
    }

    state.queued_bytes += payload_len;
    state.queue.push_front(payload);
    queue.wake.notify_one();
}

fn wait_for_event_retry() {
    let queue = event_queue();
    let state = queue.state.lock().unwrap_or_else(|err| err.into_inner());
    if state.stop {
        return;
    }
    let _ = queue
        .wake
        .wait_timeout(state, Duration::from_millis(EVENT_RETRY_INTERVAL_MS));
}

fn event_worker_loop() {
    loop {
        let payload = {
            let queue = event_queue();
            let mut state = queue.state.lock().unwrap_or_else(|err| err.into_inner());
            loop {
                if state.stop {
                    return;
                }
                if let Some(payload) = state.queue.pop_front() {
                    state.queued_bytes = state.queued_bytes.saturating_sub(payload.len());
                    break payload;
                }
                state = queue.wake.wait(state).unwrap_or_else(|err| err.into_inner());
            }
        };

        if !is_event_connected() && connect_event().is_err() {
            requeue_event_front(payload);
            wait_for_event_retry();
            continue;
        }

        if !write_event_now(&payload) {
            requeue_event_front(payload);
            wait_for_event_retry();
        }
    }
}

pub fn connect_event() -> Result<(), String> {
    ensure_event_worker();

    // Already connected — validate with a probe write
    if CONNECTED.load(Ordering::Acquire) {
        let probe_ok = write_event_now(r#"{"ev":"bridge_transport_probe"}"#);
        if probe_ok {
            return Ok(());
        }
        // write_event_now already called close_streams on failure
    }

    // Read port from temp file
    let port_str = std::fs::read_to_string(port_file_path()).map_err(|e| {
        format!("failed to read port file: {e}")
    })?;
    let port: u16 = port_str.trim().parse().map_err(|e| {
        format!("invalid port in port file '{}': {e}", port_str.trim())
    })?;

    let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| {
        LAST_ERROR.store(e.raw_os_error().unwrap_or(0) as u32, Ordering::Release);
        format!("TcpStream::connect(127.0.0.1:{port}) failed: {e}")
    })?;

    stream.set_nodelay(true).ok();
    stream
        .set_write_timeout(Some(Duration::from_millis(200)))
        .ok();

    let cmd_clone = stream.try_clone().map_err(|e| {
        format!("TcpStream::try_clone failed: {e}")
    })?;
    cmd_clone
        .set_read_timeout(Some(Duration::from_millis(5)))
        .ok();

    {
        let Ok(mut guard) = cmd_stream().lock() else {
            return Err("cmd_stream mutex poisoned".into());
        };
        *guard = Some(cmd_clone);
    }
    {
        let Ok(mut guard) = event_stream().lock() else {
            return Err("event_stream mutex poisoned".into());
        };
        *guard = Some(stream);
    }

    CONNECTED.store(true, Ordering::Release);
    LAST_ERROR.store(0, Ordering::Release);
    COMMAND_LAST_ERROR.store(0, Ordering::Release);
    Ok(())
}

pub fn connect() -> Result<(), String> {
    ensure_event_worker();
    connect_event()
}

pub fn probe_event_transport(json: &str) -> bool {
    // With TCP, write_all returns an error immediately when the peer is gone —
    // no kernel buffering masks the disconnect (unlike PIPE_NOWAIT named pipes).
    write_event_now(json)
}

pub fn write_event(json: &str) -> bool {
    ensure_event_worker();

    let queue = event_queue();
    let mut state = queue.state.lock().unwrap_or_else(|err| err.into_inner());
    if state.stop {
        return false;
    }

    let payload_len = json.len();
    if payload_len > EVENT_QUEUE_MAX_BYTES {
        return false;
    }

    while (state.queue.len() >= EVENT_QUEUE_MAX_LEN
        || state.queued_bytes.saturating_add(payload_len) > EVENT_QUEUE_MAX_BYTES)
        && !state.queue.is_empty()
    {
        if let Some(dropped) = state.queue.pop_front() {
            state.queued_bytes = state.queued_bytes.saturating_sub(dropped.len());
        }
    }

    if state.queue.len() >= EVENT_QUEUE_MAX_LEN
        || state.queued_bytes.saturating_add(payload_len) > EVENT_QUEUE_MAX_BYTES
    {
        return false;
    }

    state.queued_bytes += payload_len;
    state.queue.push_back(json.to_string());
    queue.wake.notify_one();
    true
}

pub fn poll_command_line(out: &mut [u8]) -> i32 {
    if out.is_empty() {
        return -1;
    }

    let Ok(mut cmd_guard) = cmd_stream().lock() else {
        return 0;
    };

    if let Some(ref mut stream) = *cmd_guard {
        let mut tmp = [0u8; 4096];
        match stream.read(&mut tmp) {
            Ok(0) => {
                // EOF — peer closed connection
                drop(cmd_guard);
                close_streams();
                return 0;
            }
            Ok(n) => {
                if let Ok(mut buf) = command_buffer().lock() {
                    buf.extend_from_slice(&tmp[..n]);
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                // No data available right now — normal non-blocking path
            }
            Err(e) => {
                COMMAND_LAST_ERROR
                    .store(e.raw_os_error().unwrap_or(0) as u32, Ordering::Release);
                drop(cmd_guard);
                close_streams();
                return 0;
            }
        }
    } else {
        return 0;
    }

    // Extract first newline-delimited line from the command buffer
    let Ok(mut buffer) = command_buffer().lock() else {
        return 0;
    };

    let Some(newline_pos) = buffer.iter().position(|&b| b == b'\n') else {
        return 0;
    };

    let mut line: Vec<u8> = buffer.drain(..=newline_pos).collect();
    if matches!(line.last(), Some(b'\n')) {
        line.pop();
    }
    if matches!(line.last(), Some(b'\r')) {
        line.pop();
    }

    if line.is_empty() {
        return 0;
    }

    let copy_len = line.len().min(out.len().saturating_sub(1));
    if copy_len == 0 {
        return -1;
    }
    out[..copy_len].copy_from_slice(&line[..copy_len]);
    out[copy_len] = 0;
    copy_len as i32
}

pub fn is_event_connected() -> bool {
    CONNECTED.load(Ordering::Acquire)
}

pub fn is_connected() -> bool {
    is_event_connected()
}

pub fn close() {
    stop_event_worker();
}

pub fn last_error() -> u32 {
    LAST_ERROR.load(Ordering::Acquire)
}

#[allow(dead_code)]
pub fn command_last_error() -> u32 {
    COMMAND_LAST_ERROR.load(Ordering::Acquire)
}
