//! Named-pipe server + UE4SS injector for KovaaK's.
//!
//! On startup the pipe server is created and waits (in a background thread)
//! for the injected DLL to connect.  Once connected it reads newline-delimited
//! JSON and emits each event as a `"bridge-event"` Tauri event.
//!
//! Injection is triggered by the `inject_bridge` Tauri command:
//!   1. Deploy bundled UE4SS payload files into KovaaK's `Binaries/Win64`.
//!   2. Find `FPSAimTrainer-Win64-Shipping.exe` in the process list.
//!   3. `OpenProcess` → `VirtualAllocEx` + `WriteProcessMemory` → `CreateRemoteThread(LoadLibraryW)`.
//!
//! Both the server and injector are no-ops on non-Windows / non-ocr builds.

pub const BRIDGE_EVENT: &str = "bridge-event";
#[cfg(target_os = "windows")]
pub const BRIDGE_PARSED_EVENT: &str = "bridge-parsed-event";
#[cfg(target_os = "windows")]
pub const BRIDGE_METRIC_EVENT: &str = "bridge-metric";
pub const UE4SS_LOG_EVENT: &str = "ue4ss-log-line";

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, serde::Serialize)]
pub struct BridgeParsedEvent {
    pub ev: String,
    pub value: Option<f64>,
    pub total: Option<f64>,
    pub delta: Option<f64>,
    pub field: Option<String>,
    pub source: Option<String>,
    pub raw: String,
}

#[cfg(target_os = "windows")]
fn parse_bridge_payload(raw: &str) -> Option<BridgeParsedEvent> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = parsed.as_object()?;
    let ev = obj.get("ev")?.as_str()?.trim();
    if ev.is_empty() {
        return None;
    }
    Some(BridgeParsedEvent {
        ev: ev.to_string(),
        // Support both legacy and compact payload keys emitted by the mod.
        value: parse_payload_number(obj, "value").or_else(|| parse_payload_number(obj, "v")),
        total: parse_payload_number(obj, "total").or_else(|| parse_payload_number(obj, "t")),
        delta: parse_payload_number(obj, "delta").or_else(|| parse_payload_number(obj, "d")),
        field: parse_payload_string(obj, "field"),
        source: parse_payload_string(obj, "source").or_else(|| parse_payload_string(obj, "src")),
        raw: raw.to_string(),
    })
}

#[cfg(target_os = "windows")]
fn parse_payload_number(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<f64> {
    match obj.get(key) {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::String(s)) => s.parse::<f64>().ok(),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn parse_payload_string(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

#[cfg(target_os = "windows")]
fn is_metric_event_name(ev: &str) -> bool {
    if ev.starts_with("ui_") {
        return false;
    }
    ev.starts_with("pull_")
        || ev.starts_with("derived_")
        || ev.starts_with("shot_")
        || ev.starts_with("challenge_")
        || ev == "score_source"
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeFlagState {
    pub profile: String,
    pub enable_pe_hook: bool,
    pub disable_pe_hook: bool,
    pub discovery: bool,
    pub safe_mode: bool,
    pub no_rust: bool,
    pub log_all_events: bool,
    pub object_debug: bool,
    pub non_ui_probe: bool,
    pub ui_counter_fallback: bool,
    pub score_ui_fallback: bool,
    pub hook_process_internal: bool,
    pub hook_process_local_script: bool,
    pub class_probe_hooks: bool,
    pub allow_unsafe_hooks: bool,
    pub native_hooks: bool,
    pub hook_process_event: bool,
    pub ui_settext_hook: bool,
}

// ─── Windows implementation ───────────────────────────────────────────────────

#[cfg(target_os = "windows")]
#[allow(unsafe_op_in_unsafe_fn)]
mod imp {
    use std::collections::{HashSet, VecDeque};
    use std::ffi::OsStr;
    use std::io::{Read, Seek, SeekFrom};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};

    use windows::core::{BOOL, PCSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
    use windows::Win32::Storage::FileSystem::ReadFile;
    use windows::Win32::System::Diagnostics::Debug::WriteProcessMemory;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, Process32FirstW, Process32NextW,
        MODULEENTRY32W, PROCESSENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::Win32::System::Memory::{
        VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
    };
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows::Win32::System::Threading::{
        CreateRemoteThread, OpenProcess, WaitForSingleObject, PROCESS_ALL_ACCESS,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_CONTROL,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
        ShowWindow, GW_OWNER, SW_RESTORE,
    };

    static STARTED: AtomicBool = AtomicBool::new(false);
    static LOG_TAILER_STARTED: AtomicBool = AtomicBool::new(false);
    static LOG_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
    const GAME_EXE: &str = "FPSAimTrainer-Win64-Shipping.exe";
    const UE4SS_DLL: &str = "UE4SS.dll";
    const PAYLOAD_MANIFEST_FILE: &str = ".kovaaks_overlay_payload_manifest.txt";
    const PAYLOAD_PROFILE_FILE: &str = ".kovaaks_overlay_profile";
    const PAYLOAD_DEPLOY_INFO_FILE: &str = ".kovaaks_overlay_deploy_info.txt";
    const LOG_RING_CAPACITY: usize = 1200;
    // ERROR_PIPE_CONNECTED HRESULT (client connected before ConnectNamedPipe — still OK)
    const ERROR_PIPE_CONNECTED_HRESULT: i32 = 0x80070217u32 as i32;

    fn log_ring() -> &'static Mutex<VecDeque<String>> {
        static RING: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
        RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(LOG_RING_CAPACITY)))
    }

    fn push_log_line(line: String) {
        if let Ok(mut ring) = log_ring().lock() {
            ring.push_back(line);
            while ring.len() > LOG_RING_CAPACITY {
                let _ = ring.pop_front();
            }
        }
    }

    fn emit_ue4ss_log(app: &AppHandle, line: impl Into<String>) {
        let line = line.into();
        push_log_line(line.clone());
        let _ = app.emit(super::UE4SS_LOG_EVENT, line);
    }

    fn emit_bridge_log_line(line: impl Into<String>) {
        let line = line.into();
        if let Some(app) = LOG_APP_HANDLE.get() {
            emit_ue4ss_log(app, line);
        } else {
            push_log_line(line);
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    // ─── Pipe server ─────────────────────────────────────────────────────────

    pub fn start(app: AppHandle) {
        let _ = LOG_APP_HANDLE.set(app.clone());
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::Builder::new()
            .name("bridge-pipe".into())
            .spawn(move || pipe_server_loop(app))
            .ok();
    }

    fn pipe_server_loop(app: AppHandle) {
        let name = to_wide("\\\\.\\pipe\\kovaaks-bridge");
        // PIPE_ACCESS_INBOUND = 0x00000001
        let pipe = unsafe {
            CreateNamedPipeW(
                windows::core::PCWSTR(name.as_ptr()),
                windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0x00000001), // PIPE_ACCESS_INBOUND
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,     // max instances
                0,     // out buffer (server only reads)
                65536, // in buffer
                0,     // default timeout
                None,  // default security
            )
        };
        use windows::Win32::Foundation::INVALID_HANDLE_VALUE;
        if pipe == INVALID_HANDLE_VALUE {
            log::error!("bridge: CreateNamedPipe failed");
            return;
        }

        loop {
            log::debug!("bridge: waiting for DLL connection");
            unsafe {
                let r = ConnectNamedPipe(pipe, None);
                if let Err(ref e) = r {
                    // ERROR_PIPE_CONNECTED means the client connected before us — still good
                    if e.code().0 != ERROR_PIPE_CONNECTED_HRESULT {
                        log::error!("bridge: ConnectNamedPipe: {e}");
                        break;
                    }
                }
            }

            log::info!("bridge: DLL connected — reading events");
            read_events(pipe, &app);
            log::info!("bridge: pipe disconnected — waiting for next connection");

            unsafe {
                let _ = DisconnectNamedPipe(pipe);
            }
        }

        unsafe {
            let _ = CloseHandle(pipe);
        }
    }

    fn read_events(pipe: HANDLE, app: &AppHandle) {
        let mut buf: Vec<u8> = Vec::with_capacity(4096);
        let mut tmp = [0u8; 512];
        loop {
            let mut nread = 0u32;
            match unsafe { ReadFile(pipe, Some(&mut tmp), Some(&mut nread), None) } {
                Ok(_) if nread > 0 => {
                    buf.extend_from_slice(&tmp[..nread as usize]);
                    // Drain all complete newline-terminated lines
                    while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                        let chunk: Vec<u8> = buf.drain(..=nl).collect();
                        if let Ok(s) = std::str::from_utf8(&chunk[..chunk.len() - 1]) {
                            log::info!("bridge event: {s}");
                            emit_ue4ss_log(app, format!("[bridge] {s}"));
                            let _ = app.emit(super::BRIDGE_EVENT, s.to_owned());
                            if let Some(parsed) = super::parse_bridge_payload(s) {
                                let _ = app.emit(super::BRIDGE_PARSED_EVENT, &parsed);
                                if super::is_metric_event_name(&parsed.ev) {
                                    let _ = app.emit(super::BRIDGE_METRIC_EVENT, &parsed);
                                }
                            }
                        }
                    }
                }
                // Pipe broken or zero bytes — client disconnected
                _ => break,
            }
        }
    }

    fn files_identical(a: &Path, b: &Path) -> Result<bool, String> {
        let ma = std::fs::metadata(a)
            .map_err(|e| format!("Failed to stat {}: {}", a.display(), e))?;
        let mb = std::fs::metadata(b)
            .map_err(|e| format!("Failed to stat {}: {}", b.display(), e))?;
        if ma.len() != mb.len() {
            return Ok(false);
        }
        let mut fa = std::fs::File::open(a)
            .map_err(|e| format!("Failed to open {}: {}", a.display(), e))?;
        let mut fb = std::fs::File::open(b)
            .map_err(|e| format!("Failed to open {}: {}", b.display(), e))?;
        let mut ba = [0u8; 64 * 1024];
        let mut bb = [0u8; 64 * 1024];
        loop {
            let na = fa
                .read(&mut ba)
                .map_err(|e| format!("Failed to read {}: {}", a.display(), e))?;
            let nb = fb
                .read(&mut bb)
                .map_err(|e| format!("Failed to read {}: {}", b.display(), e))?;
            if na != nb {
                return Ok(false);
            }
            if na == 0 {
                break;
            }
            if ba[..na] != bb[..na] {
                return Ok(false);
            }
        }
        Ok(true)
    }

    // ─── DLL injector ────────────────────────────────────────────────────────

    pub fn deploy_and_inject(resource_dir: &Path, stats_dir: &str) -> Result<(), String> {
        let payload_root = resource_dir.join("ue4ss");
        if !payload_root.is_dir() {
            return Err(format!(
                "UE4SS payload missing at {} (expected bundled resource folder `ue4ss`)",
                payload_root.display()
            ));
        }

        let game_bin_dir = resolve_game_bin_dir(stats_dir)?;
        let flags_before_sync = read_runtime_flags_for_dir(&game_bin_dir);
        log::info!(
            "bridge: runtime flags before sync profile={} enable_pe_hook={} disable_pe_hook={} discovery={} safe_mode={} no_rust={} log_all_events={} object_debug={} non_ui_probe={} hook_process_internal={} hook_process_local_script={} class_probe_hooks={}",
            flags_before_sync.profile,
            flags_before_sync.enable_pe_hook,
            flags_before_sync.disable_pe_hook,
            flags_before_sync.discovery,
            flags_before_sync.safe_mode,
            flags_before_sync.no_rust,
            flags_before_sync.log_all_events,
            flags_before_sync.object_debug,
            flags_before_sync.non_ui_probe,
            flags_before_sync.hook_process_internal,
            flags_before_sync.hook_process_local_script,
            flags_before_sync.class_probe_hooks
        );
        emit_bridge_log_line(format!(
            "[bridge] runtime flags before sync profile={} enable_pe_hook={} disable_pe_hook={} discovery={} safe_mode={} no_rust={} log_all_events={} object_debug={} non_ui_probe={} hook_process_internal={} hook_process_local_script={} class_probe_hooks={}",
            flags_before_sync.profile,
            flags_before_sync.enable_pe_hook,
            flags_before_sync.disable_pe_hook,
            flags_before_sync.discovery,
            flags_before_sync.safe_mode,
            flags_before_sync.no_rust,
            flags_before_sync.log_all_events,
            flags_before_sync.object_debug,
            flags_before_sync.non_ui_probe,
            flags_before_sync.hook_process_internal,
            flags_before_sync.hook_process_local_script,
            flags_before_sync.class_probe_hooks
        ));
        let pid = find_process(GAME_EXE);
        let already_loaded = pid
            .map(|p| find_loaded_module(p, UE4SS_DLL).is_some())
            .unwrap_or(false);
        sync_payload(&payload_root, &game_bin_dir, already_loaded)?;
        let managed_mod_dll = game_bin_dir
            .join("Mods")
            .join("KovaaksBridgeMod")
            .join("dlls")
            .join("main.dll");
        let managed_mod_enabled = game_bin_dir
            .join("Mods")
            .join("KovaaksBridgeMod")
            .join("enabled.txt");
        let managed_rust_core = game_bin_dir.join("kovaaks_rust_core.dll");
        if !managed_mod_dll.is_file() {
            return Err(format!(
                "Managed mod DLL missing after sync: {}",
                managed_mod_dll.display()
            ));
        }
        if !managed_mod_enabled.is_file() {
            return Err(format!(
                "Managed mod enabled marker missing after sync: {}",
                managed_mod_enabled.display()
            ));
        }
        if !managed_rust_core.is_file() {
            return Err(format!(
                "Rust bridge DLL missing after sync: {}",
                managed_rust_core.display()
            ));
        }
        emit_bridge_log_line(format!(
            "[bridge] managed mod payload present: main.dll={} enabled.txt={} rust_core={}",
            managed_mod_dll.display(),
            managed_mod_enabled.display(),
            managed_rust_core.display()
        ));
        let payload_mod_dll = payload_root
            .join("Mods")
            .join("KovaaksBridgeMod")
            .join("dlls")
            .join("main.dll");
        let payload_rust_core = payload_root.join("kovaaks_rust_core.dll");
        if payload_mod_dll.is_file() {
            match files_identical(&payload_mod_dll, &managed_mod_dll) {
                Ok(true) => emit_bridge_log_line("[bridge] managed mod dll is up to date"),
                Ok(false) => {
                    log::warn!(
                        "bridge: managed mod DLL differs from staged payload (likely locked while running): {}",
                        managed_mod_dll.display()
                    );
                    emit_bridge_log_line(format!(
                        "[bridge] warning: managed mod dll differs from staged payload; restart game to apply: {}",
                        managed_mod_dll.display()
                    ));
                }
                Err(e) => {
                    log::warn!("bridge: could not compare managed mod DLLs: {e}");
                }
            }
        }
        if payload_rust_core.is_file() {
            match files_identical(&payload_rust_core, &managed_rust_core) {
                Ok(true) => emit_bridge_log_line("[bridge] rust core dll is up to date"),
                Ok(false) => {
                    log::warn!(
                        "bridge: rust core DLL differs from staged payload (likely locked while running): {}",
                        managed_rust_core.display()
                    );
                    emit_bridge_log_line(format!(
                        "[bridge] warning: rust core dll differs from staged payload; restart game to apply: {}",
                        managed_rust_core.display()
                    ));
                }
                Err(e) => {
                    log::warn!("bridge: could not compare rust core DLLs: {e}");
                }
            }
        }
        let flags_after_sync = read_runtime_flags_for_dir(&game_bin_dir);
        if flags_after_sync != flags_before_sync {
            log::warn!(
                "bridge: runtime flags changed by sync before={:?} after={:?}",
                flags_before_sync,
                flags_after_sync
            );
            emit_bridge_log_line(format!(
                "[bridge] runtime flags changed by sync before={:?} after={:?}",
                flags_before_sync,
                flags_after_sync
            ));
        } else {
            emit_bridge_log_line(format!(
                "[bridge] runtime flags unchanged after sync profile={} enable_pe_hook={} disable_pe_hook={} discovery={} safe_mode={} no_rust={} log_all_events={} object_debug={} non_ui_probe={} hook_process_internal={} hook_process_local_script={} class_probe_hooks={}",
                flags_after_sync.profile,
                flags_after_sync.enable_pe_hook,
                flags_after_sync.disable_pe_hook,
                flags_after_sync.discovery,
                flags_after_sync.safe_mode,
                flags_after_sync.no_rust,
                flags_after_sync.log_all_events,
                flags_after_sync.object_debug,
                flags_after_sync.non_ui_probe,
                flags_after_sync.hook_process_internal,
                flags_after_sync.hook_process_local_script,
                flags_after_sync.class_probe_hooks
            ));
        }
        log::info!(
            "bridge: UE4SS payload deployed to {}",
            game_bin_dir.display()
        );
        start_log_tailer_for_bin_dir(game_bin_dir.clone(), None);

        let ue4ss_path = game_bin_dir.join(UE4SS_DLL);
        if !ue4ss_path.is_file() {
            return Err(format!(
                "UE4SS runtime not found after deploy: {}",
                ue4ss_path.display()
            ));
        }

        let pid = match pid {
            Some(pid) => pid,
            None => return Err(format!("{GAME_EXE} is not running")),
        };

        if already_loaded {
            log::warn!(
                "bridge: UE4SS already loaded in pid {pid}; payload synced. \
                 Runtime/settings changes require game restart."
            );
            match trigger_hot_reload() {
                Ok(()) => {
                    log::info!("bridge: triggered UE4SS hot reload after payload sync");
                }
                Err(e) => {
                    log::warn!("bridge: UE4SS hot reload failed after payload sync: {e}");
                }
            }
            return Ok(());
        }

        inject(
            ue4ss_path
                .to_str()
                .ok_or_else(|| "UE4SS DLL path is not valid UTF-8".to_string())?,
        )
    }

    pub fn inject(dll_path: &str) -> Result<(), String> {
        log::info!("bridge: injecting {dll_path}");
        let pid = match find_process(GAME_EXE) {
            Some(pid) => pid,
            None => {
                log::error!("bridge: could not find process {GAME_EXE}");
                return Err(format!("{GAME_EXE} is not running"));
            }
        };

        if find_loaded_module(pid, UE4SS_DLL).is_some() {
            log::info!("bridge: UE4SS already loaded in pid {pid} — skipping injection");
            return Ok(());
        }

        match inject_dll(pid, dll_path) {
            Ok(()) => Ok(()),
            Err(e) => {
                log::error!("bridge: DLL injection failed: {e}");
                Err(e)
            }
        }
    }

    pub fn start_log_tailer(app: AppHandle, stats_dir: &str) -> Result<(), String> {
        let game_bin_dir = resolve_game_bin_dir(stats_dir)?;
        start_log_tailer_for_bin_dir(game_bin_dir, Some(app));
        Ok(())
    }

    fn start_log_tailer_for_bin_dir(game_bin_dir: PathBuf, app: Option<AppHandle>) {
        if let Some(ref app) = app {
            let _ = LOG_APP_HANDLE.set(app.clone());
        }
        if LOG_TAILER_STARTED.swap(true, Ordering::SeqCst) {
            return;
        }

        std::thread::Builder::new()
            .name("ue4ss-log-tail".into())
            .spawn(move || ue4ss_log_tail_loop(game_bin_dir, app))
            .ok();
    }

    pub fn recent_logs(limit: usize) -> Vec<String> {
        let cap = limit.clamp(1, LOG_RING_CAPACITY);
        if let Ok(ring) = log_ring().lock() {
            let len = ring.len();
            let start = len.saturating_sub(cap);
            return ring.iter().skip(start).cloned().collect();
        }
        Vec::new()
    }

    fn ue4ss_log_tail_loop(game_bin_dir: PathBuf, app: Option<AppHandle>) {
        struct TailState {
            path: PathBuf,
            tag: &'static str,
            offset: u64,
            carry: String,
            announced: bool,
        }

        let mut states = vec![
            TailState {
                path: game_bin_dir.join("UE4SS.log"),
                tag: "ue4ss",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("ue4ss.log"),
                tag: "ue4ss",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("UE4SS.log.txt"),
                tag: "ue4ss",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("UE4SS").join("UE4SS.log"),
                tag: "ue4ss",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("KovaaksBridgeMod.runtime.log"),
                tag: "kmod",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("KovaaksBridgeMod.trace.log"),
                tag: "kmod-trace",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
            TailState {
                path: game_bin_dir.join("KovaaksBridgeMod.events.log"),
                tag: "kmod-events",
                offset: 0,
                carry: String::new(),
                announced: false,
            },
        ];

        loop {
            for state in &mut states {
                match std::fs::metadata(&state.path) {
                    Ok(meta) => {
                        if !state.announced {
                            state.offset = meta.len().saturating_sub(16 * 1024);
                            if let Some(ref app) = app {
                                emit_ue4ss_log(
                                    app,
                                    format!("[ue4ss-log] tailing {}", state.path.display()),
                                );
                            }
                            state.announced = true;
                        }

                        if meta.len() < state.offset {
                            state.offset = 0;
                            state.carry.clear();
                        }
                        if meta.len() <= state.offset {
                            continue;
                        }

                        match std::fs::File::open(&state.path) {
                            Ok(mut f) => {
                                if f.seek(SeekFrom::Start(state.offset)).is_err() {
                                    continue;
                                }
                                let mut bytes = Vec::new();
                                if f.read_to_end(&mut bytes).is_err() {
                                    continue;
                                }
                                state.offset = meta.len();
                                if bytes.is_empty() {
                                    continue;
                                }

                                let chunk = String::from_utf8_lossy(&bytes);
                                let text = if state.carry.is_empty() {
                                    chunk.into_owned()
                                } else {
                                    let mut merged = state.carry.clone();
                                    merged.push_str(&chunk);
                                    state.carry.clear();
                                    merged
                                };

                                let ended_with_newline = text.ends_with('\n');
                                let mut lines: Vec<&str> = text.lines().collect();
                                if !ended_with_newline {
                                    if let Some(last) = lines.pop() {
                                        state.carry = last.to_string();
                                    }
                                }

                                for line in lines {
                                    let line = line.trim_end_matches('\r').trim();
                                    if line.is_empty() {
                                        continue;
                                    }
                                    let out = format!("[{}] {}", state.tag, line);
                                    push_log_line(out.clone());
                                    if let Some(ref app) = app {
                                        let _ = app.emit(super::UE4SS_LOG_EVENT, out);
                                    }
                                }
                            }
                            Err(_) => {
                                state.offset = 0;
                                state.carry.clear();
                                state.announced = false;
                            }
                        }
                    }
                    Err(_) => {
                        state.offset = 0;
                        state.carry.clear();
                        state.announced = false;
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(300));
        }
    }

    pub fn trigger_hot_reload() -> Result<(), String> {
        let pid = match find_process(GAME_EXE) {
            Some(pid) => pid,
            None => return Err(format!("{GAME_EXE} is not running")),
        };

        // Hot reload keybind is consumed by the game, so bring KovaaK's to foreground first.
        if let Some(hwnd) = find_main_window_for_pid(pid) {
            unsafe {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
            }
            std::thread::sleep(Duration::from_millis(40));
        } else {
            log::warn!("bridge: could not find KovaaK window for hot reload keybind");
        }

        if find_loaded_module(pid, UE4SS_DLL).is_none() {
            return Err("UE4SS.dll is not loaded; inject bridge first".to_string());
        }

        if find_process(GAME_EXE).is_none() {
            return Err(format!("{GAME_EXE} is not running"));
        }

        let ctrl = VK_CONTROL.0 as u16;
        let r = b'R' as u16;
        let inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(ctrl),
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(r),
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(r),
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(ctrl),
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];

        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == 0 {
            return Err("SendInput failed for Ctrl+R".to_string());
        }
        Ok(())
    }

    pub fn get_runtime_flags(stats_dir: &str) -> Result<super::RuntimeFlagState, String> {
        let game_bin_dir = resolve_game_bin_dir(stats_dir)?;
        let state = read_runtime_flags_for_dir(&game_bin_dir);
        log::info!(
            "bridge: detected runtime flags profile={} enable_pe_hook={} disable_pe_hook={} discovery={} safe_mode={} no_rust={} log_all_events={} object_debug={} non_ui_probe={} hook_process_internal={} hook_process_local_script={} class_probe_hooks={} allow_unsafe_hooks={}",
            state.profile,
            state.enable_pe_hook,
            state.disable_pe_hook,
            state.discovery,
            state.safe_mode,
            state.no_rust,
            state.log_all_events,
            state.object_debug,
            state.non_ui_probe,
            state.hook_process_internal,
            state.hook_process_local_script,
            state.class_probe_hooks,
            state.allow_unsafe_hooks
        );
        emit_bridge_log_line(format!(
            "[bridge] runtime flags detected profile={} enable_pe_hook={} disable_pe_hook={} discovery={} safe_mode={} no_rust={} log_all_events={} object_debug={} non_ui_probe={} hook_process_internal={} hook_process_local_script={} class_probe_hooks={} allow_unsafe_hooks={}",
            state.profile,
            state.enable_pe_hook,
            state.disable_pe_hook,
            state.discovery,
            state.safe_mode,
            state.no_rust,
            state.log_all_events,
            state.object_debug,
            state.non_ui_probe,
            state.hook_process_internal,
            state.hook_process_local_script,
            state.class_probe_hooks,
            state.allow_unsafe_hooks
        ));
        Ok(state)
    }

    fn read_runtime_flags_for_dir(game_bin_dir: &Path) -> super::RuntimeFlagState {
        let profile = std::fs::read_to_string(game_bin_dir.join(PAYLOAD_PROFILE_FILE))
            .map(|s| s.trim().to_ascii_lowercase())
            .unwrap_or_else(|_| "unknown".to_string());
        super::RuntimeFlagState {
            profile,
            enable_pe_hook: game_bin_dir.join("kovaaks_enable_pe_hook.flag").is_file(),
            disable_pe_hook: game_bin_dir.join("kovaaks_disable_pe_hook.flag").is_file(),
            discovery: game_bin_dir.join("kovaaks_discovery.flag").is_file(),
            safe_mode: game_bin_dir.join("kovaaks_safe_mode.flag").is_file(),
            no_rust: game_bin_dir.join("kovaaks_no_rust.flag").is_file(),
            log_all_events: game_bin_dir.join("kovaaks_log_all_events.flag").is_file(),
            object_debug: game_bin_dir.join("kovaaks_object_debug.flag").is_file(),
            non_ui_probe: game_bin_dir.join("kovaaks_non_ui_probe.flag").is_file(),
            ui_counter_fallback: game_bin_dir.join("kovaaks_ui_counter_fallback.flag").is_file(),
            score_ui_fallback: game_bin_dir.join("kovaaks_score_ui_fallback.flag").is_file(),
            hook_process_internal: game_bin_dir.join("kovaaks_hook_process_internal.flag").is_file(),
            hook_process_local_script: game_bin_dir
                .join("kovaaks_hook_process_local_script.flag")
                .is_file(),
            class_probe_hooks: game_bin_dir.join("kovaaks_class_probe_hooks.flag").is_file(),
            allow_unsafe_hooks: game_bin_dir.join("kovaaks_allow_unsafe_hooks.flag").is_file(),
            native_hooks: game_bin_dir.join("kovaaks_native_hooks.flag").is_file(),
            hook_process_event: game_bin_dir.join("kovaaks_hook_process_event.flag").is_file(),
            ui_settext_hook: game_bin_dir.join("kovaaks_ui_settext_hook.flag").is_file(),
        }
    }

    pub fn set_runtime_flag(stats_dir: &str, key: &str, enabled: bool) -> Result<(), String> {
        let game_bin_dir = resolve_game_bin_dir(stats_dir)?;
        let file = match key {
            "enable_pe_hook" => "kovaaks_enable_pe_hook.flag",
            "disable_pe_hook" => "kovaaks_disable_pe_hook.flag",
            "discovery" => "kovaaks_discovery.flag",
            "safe_mode" => "kovaaks_safe_mode.flag",
            "no_rust" => "kovaaks_no_rust.flag",
            "log_all_events" => "kovaaks_log_all_events.flag",
            "object_debug" => "kovaaks_object_debug.flag",
            "non_ui_probe" => "kovaaks_non_ui_probe.flag",
            "ui_counter_fallback" => "kovaaks_ui_counter_fallback.flag",
            "score_ui_fallback" => "kovaaks_score_ui_fallback.flag",
            "hook_process_internal" => "kovaaks_hook_process_internal.flag",
            "hook_process_local_script" => "kovaaks_hook_process_local_script.flag",
            "class_probe_hooks" => "kovaaks_class_probe_hooks.flag",
            "allow_unsafe_hooks" => "kovaaks_allow_unsafe_hooks.flag",
            "native_hooks" => "kovaaks_native_hooks.flag",
            "hook_process_event" => "kovaaks_hook_process_event.flag",
            "ui_settext_hook" => "kovaaks_ui_settext_hook.flag",
            _ => return Err(format!("Unknown UE4SS runtime flag key: {key}")),
        };
        let path = game_bin_dir.join(file);
        if enabled {
            std::fs::write(&path, b"1")
                .map_err(|e| format!("Failed to create {}: {}", path.display(), e))?;
            log::info!("bridge: set runtime flag {}=1 ({})", key, path.display());
            emit_bridge_log_line(format!(
                "[bridge] runtime flag set {}=1 ({})",
                key,
                path.display()
            ));
        } else if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
            log::info!("bridge: set runtime flag {}=0 ({})", key, path.display());
            emit_bridge_log_line(format!(
                "[bridge] runtime flag set {}=0 ({})",
                key,
                path.display()
            ));
        } else {
            log::info!("bridge: runtime flag {} already 0 ({})", key, path.display());
            emit_bridge_log_line(format!(
                "[bridge] runtime flag already {}=0 ({})",
                key,
                path.display()
            ));
        }
        Ok(())
    }

    pub fn request_runtime_flag_reload(stats_dir: &str) -> Result<(), String> {
        let game_bin_dir = resolve_game_bin_dir(stats_dir)?;
        let path = game_bin_dir.join("kovaaks_reload_flags.flag");
        std::fs::write(&path, b"1")
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
        log::info!("bridge: requested runtime flag reload ({})", path.display());
        emit_bridge_log_line(format!(
            "[bridge] requested runtime flag reload ({})",
            path.display()
        ));
        Ok(())
    }

    fn find_main_window_for_pid(pid: u32) -> Option<HWND> {
        struct EnumCtx {
            pid: u32,
            hwnd: HWND,
        }

        unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let ctx = &mut *(lparam.0 as *mut EnumCtx);
            let mut win_pid = 0u32;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut win_pid));
            if win_pid != ctx.pid {
                return BOOL(1);
            }
            if !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }
            let has_owner = match GetWindow(hwnd, GW_OWNER) {
                Ok(owner) => !owner.is_invalid(),
                Err(_) => false,
            };
            if has_owner {
                return BOOL(1);
            }
            ctx.hwnd = hwnd;
            BOOL(0)
        }

        let mut ctx = EnumCtx {
            pid,
            hwnd: HWND::default(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(enum_windows_proc),
                LPARAM((&mut ctx as *mut EnumCtx) as isize),
            );
        }
        if ctx.hwnd.is_invalid() {
            None
        } else {
            Some(ctx.hwnd)
        }
    }

    /// Scan the module list of `pid` for a DLL whose name matches `dll_name` (case-insensitive).
    /// Returns the module base address if found.
    fn find_loaded_module(pid: u32, dll_name: &str) -> Option<*mut std::ffi::c_void> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid).ok()?;
            let mut entry = MODULEENTRY32W {
                dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
                ..Default::default()
            };
            if Module32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let len = entry
                        .szModule
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szModule.len());
                    let name = String::from_utf16_lossy(&entry.szModule[..len]);
                    if name.eq_ignore_ascii_case(dll_name) {
                        let _ = CloseHandle(snap);
                        return Some(entry.modBaseAddr as *mut std::ffi::c_void);
                    }
                    if Module32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
            None
        }
    }

    fn find_process(exe_name: &str) -> Option<u32> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                    if name.eq_ignore_ascii_case(exe_name) {
                        let _ = CloseHandle(snap);
                        return Some(entry.th32ProcessID);
                    }
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
            None
        }
    }

    fn inject_dll(pid: u32, dll_path: &str) -> Result<(), String> {
        let dll_wide = to_wide(dll_path);
        let dll_bytes = dll_wide.len() * std::mem::size_of::<u16>();

        unsafe {
            let proc = match OpenProcess(PROCESS_ALL_ACCESS, false, pid) {
                Ok(proc) => proc,
                Err(e) => {
                    log::error!("bridge: OpenProcess failed: {e}");
                    return Err(format!("OpenProcess: {e}"));
                }
            };

            let remote = VirtualAllocEx(
                proc,
                None,
                dll_bytes,
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE,
            );
            if remote.is_null() {
                log::error!("bridge: VirtualAllocEx failed");
                let _ = CloseHandle(proc);
                return Err("VirtualAllocEx failed".into());
            }

            if let Err(e) =
                WriteProcessMemory(proc, remote, dll_wide.as_ptr().cast(), dll_bytes, None)
            {
                log::error!("bridge: WriteProcessMemory failed: {e}");
                let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
                let _ = CloseHandle(proc);
                return Err(format!("WriteProcessMemory: {e}"));
            }

            let k32 = match GetModuleHandleW(windows::core::w!("kernel32.dll")) {
                Ok(h) => h,
                Err(e) => {
                    log::error!("bridge: GetModuleHandleW failed: {e}");
                    let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
                    let _ = CloseHandle(proc);
                    return Err(format!("GetModuleHandleW: {e}"));
                }
            };
            let load_lib = match GetProcAddress(k32, PCSTR(b"LoadLibraryW\0".as_ptr())) {
                Some(addr) => addr,
                None => {
                    log::error!("bridge: GetProcAddress(LoadLibraryW) failed");
                    let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
                    let _ = CloseHandle(proc);
                    return Err("GetProcAddress(LoadLibraryW) failed".into());
                }
            };

            let thread = match CreateRemoteThread(
                proc,
                None,
                0,
                Some(std::mem::transmute(load_lib)),
                Some(remote.cast_const()),
                0u32, // flags
                None,
            ) {
                Ok(thread) => thread,
                Err(e) => {
                    log::error!("bridge: CreateRemoteThread failed: {e}");
                    let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
                    let _ = CloseHandle(proc);
                    return Err(format!("CreateRemoteThread: {e}"));
                }
            };

            // Wait up to 5 s for the DLL to load, then clean up
            WaitForSingleObject(thread, 5000);
            let _ = CloseHandle(thread);
            let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
            let _ = CloseHandle(proc);
        }

        log::info!("bridge: successfully injected into pid {pid}");
        Ok(())
    }

    fn resolve_game_bin_dir(stats_dir: &str) -> Result<PathBuf, String> {
        let stats = PathBuf::from(stats_dir);
        let game_root = stats
            .parent()
            .ok_or_else(|| format!("Invalid stats dir: {}", stats.display()))?;
        let bin_dir = game_root.join("Binaries").join("Win64");
        if !bin_dir.exists() {
            return Err(format!(
                "KovaaK's Binaries/Win64 not found at {} (from stats_dir={})",
                bin_dir.display(),
                stats_dir
            ));
        }
        Ok(bin_dir)
    }

    fn sync_payload(
        src_root: &Path,
        dst_root: &Path,
        tolerate_locked_files: bool,
    ) -> Result<(), String> {
        let profile = read_payload_profile(src_root);
        let desired_files = collect_payload_files(src_root, &profile)?;

        cleanup_legacy_ue4ss_files(dst_root, tolerate_locked_files)?;
        cleanup_payload_from_manifest(dst_root, tolerate_locked_files, &desired_files)?;

        let engine_override = read_engine_override(src_root);
        log::info!(
            "bridge: syncing UE4SS payload profile={} from {}",
            profile,
            src_root.display()
        );
        if let Some((major, minor)) = engine_override {
            log::info!(
                "bridge: payload UE4SS settings EngineVersionOverride={}.{}",
                major,
                minor
            );
        }

        // Replace our mod directory atomically-ish so stale files from older builds
        // never linger across updates.
        let managed_mod_rel = Path::new("Mods").join("KovaaksBridgeMod");
        let src_mod_dir = src_root.join(&managed_mod_rel);
        let dst_mod_dir = dst_root.join(&managed_mod_rel);
        if src_mod_dir.is_dir() && dst_mod_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&dst_mod_dir) {
                if tolerate_locked_files && is_permission_denied(&e) {
                    log::warn!(
                        "bridge: could not replace managed mod directory (in use): {} ({})",
                        dst_mod_dir.display(),
                        e
                    );
                } else {
                    return Err(format!(
                        "Failed to replace managed mod directory {}: {}",
                        dst_mod_dir.display(),
                        e
                    ));
                }
            }
        }

        let mut copied_paths = Vec::new();
        let copied = copy_dir_recursive(
            src_root,
            dst_root,
            src_root,
            &profile,
            tolerate_locked_files,
            &mut copied_paths,
        )?;
        write_payload_manifest(dst_root, &copied_paths)?;
        if let Err(e) =
            write_payload_deploy_info(dst_root, src_root, &profile, engine_override, copied)
        {
            log::warn!("bridge: failed to write payload deploy marker: {e}");
        }
        log::info!(
            "bridge: synced {} UE4SS payload file(s) from {} to {}",
            copied,
            src_root.display(),
            dst_root.display()
        );
        Ok(())
    }

    fn read_payload_profile(src_root: &Path) -> String {
        let marker = src_root.join(PAYLOAD_PROFILE_FILE);
        match std::fs::read_to_string(&marker) {
            Ok(content) => {
                let raw = content.trim().to_ascii_lowercase();
                if raw == "minimal" || raw == "full" {
                    raw
                } else {
                    "minimal".to_string()
                }
            }
            Err(_) => {
                // Safe default if marker is missing: minimal.
                "minimal".to_string()
            }
        }
    }

    fn read_engine_override(src_root: &Path) -> Option<(u32, u32)> {
        let ini_path = src_root.join("UE4SS-settings.ini");
        let content = std::fs::read_to_string(ini_path).ok()?;
        let mut major: Option<u32> = None;
        let mut minor: Option<u32> = None;
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(v) = trimmed.strip_prefix("MajorVersion") {
                let val = v.split('=').nth(1)?.trim().parse::<u32>().ok()?;
                major = Some(val);
                continue;
            }
            if let Some(v) = trimmed.strip_prefix("MinorVersion") {
                let val = v.split('=').nth(1)?.trim().parse::<u32>().ok()?;
                minor = Some(val);
                continue;
            }
        }
        Some((major?, minor?))
    }

    fn cleanup_legacy_ue4ss_files(
        dst_root: &Path,
        tolerate_locked_files: bool,
    ) -> Result<(), String> {
        // Prevent auto-load of UE4SS via proxy DLL when overlay is not running.
        let _ = remove_path_if_exists(&dst_root.join("dwmapi.dll"), tolerate_locked_files)?;

        let legacy_files = [
            "UE4SS.pdb",
            "API.txt",
            "Changelog.md",
            "README.md",
            "README.txt",
            "Readme.md",
            "Readme.txt",
        ];
        for rel in legacy_files {
            let _ = remove_path_if_exists(&dst_root.join(rel), tolerate_locked_files)?;
        }

        // Remove known upstream sample/config folders from older full payloads.
        let legacy_dirs = [
            "CustomGameConfigs",
            "MapGenBP",
            "Atomic Heart",
            "Borderlands 3",
            "Final Fantasy 7 Remake",
            "Fuser",
            "Ghost Wire Tokyo",
            "Kingdom Hearts 3",
            "Like a Dragon Ishin!",
            "Returnal",
            "SCP 5K",
            "Satisfactory",
            "Star Wars Jedi Fallen Order",
            "Star Wars Jedi Survivor",
            "The Outer Worlds",
            "Walking Dead Saints & Sinners",
        ];
        for rel in legacy_dirs {
            let _ = remove_path_if_exists(&dst_root.join(rel), tolerate_locked_files)?;
        }
        let _ = remove_path_if_exists(
            &dst_root.join("Content").join("MapGen"),
            tolerate_locked_files,
        )?;

        // Remove known built-in UE4SS sample mods from older payloads.
        let legacy_mods = [
            "ActorDumperMod",
            "BPML_GenericFunctions",
            "BPModLoaderMod",
            "CheatManagerEnablerMod",
            "ConsoleCommandsMod",
            "ConsoleEnablerMod",
            "Keybinds",
            "LineTraceMod",
            "SplitScreenMod",
            "jsbLuaProfilerMod",
            "shared",
        ];
        let mods_root = dst_root.join("Mods");
        for name in legacy_mods {
            let _ = remove_path_if_exists(&mods_root.join(name), tolerate_locked_files)?;
        }
        // Remove duplicate copies of our managed mod left behind under alternate
        // folder names by older experiments.
        if let Ok(entries) = std::fs::read_dir(&mods_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name.eq_ignore_ascii_case("KovaaksBridgeMod") {
                    continue;
                }
                let mod_json = path.join("mod.json");
                if !mod_json.is_file() {
                    continue;
                }
                let Ok(content) = std::fs::read_to_string(&mod_json) else {
                    continue;
                };
                if content.contains("\"mod_name\"") && content.contains("KovaaksBridgeMod") {
                    let _ = remove_path_if_exists(&path, tolerate_locked_files)?;
                    log::warn!(
                        "bridge: removed duplicate managed mod directory {}",
                        path.display()
                    );
                }
            }
        }
        Ok(())
    }

    fn payload_manifest_path(dst_root: &Path) -> PathBuf {
        dst_root.join(PAYLOAD_MANIFEST_FILE)
    }

    fn cleanup_payload_from_manifest(
        dst_root: &Path,
        tolerate_locked_files: bool,
        desired_files: &HashSet<String>,
    ) -> Result<(), String> {
        let manifest_path = payload_manifest_path(dst_root);
        if !manifest_path.is_file() {
            return Ok(());
        }

        let manifest = std::fs::read_to_string(&manifest_path).map_err(|e| {
            format!(
                "Failed to read payload manifest {}: {}",
                manifest_path.display(),
                e
            )
        })?;

        let mut removed = 0usize;
        let mut skipped_locked = 0usize;
        for rel in manifest
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if desired_files.contains(rel) {
                // Still part of current payload; prefer overwrite-in-place over delete-first.
                continue;
            }
            let rel_path = Path::new(rel);
            if rel_path.is_absolute() {
                continue;
            }
            let abs_path = dst_root.join(rel_path);
            if !abs_path.exists() {
                continue;
            }
            if remove_path_if_exists(&abs_path, tolerate_locked_files)? {
                prune_empty_parent_dirs(abs_path.parent(), dst_root);
                removed += 1;
            } else if abs_path.exists() {
                skipped_locked += 1;
            }
        }

        if skipped_locked == 0 {
            let _ = remove_path_if_exists(&manifest_path, tolerate_locked_files)?;
        } else {
            log::warn!(
                "bridge: skipped {} locked file(s) from previous payload manifest; keeping manifest for next restart",
                skipped_locked
            );
        }
        if removed > 0 {
            log::info!(
                "bridge: removed {} file(s) from previous payload manifest",
                removed
            );
        }
        Ok(())
    }

    fn collect_payload_files(src_root: &Path, profile: &str) -> Result<HashSet<String>, String> {
        let mut out = HashSet::new();
        collect_payload_files_recursive(src_root, src_root, profile, &mut out)?;
        Ok(out)
    }

    fn collect_payload_files_recursive(
        root: &Path,
        current: &Path,
        profile: &str,
        out: &mut HashSet<String>,
    ) -> Result<(), String> {
        let entries = std::fs::read_dir(current)
            .map_err(|e| format!("Failed to enumerate {}: {}", current.display(), e))?;

        for entry in entries {
            let entry = entry
                .map_err(|e| format!("Failed to read dir entry in {}: {}", current.display(), e))?;
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == ".gitkeep" || name_str.ends_with(".md") {
                continue;
            }

            let ty = entry
                .file_type()
                .map_err(|e| format!("Failed to get file type for {}: {}", path.display(), e))?;
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| String::new());

            if profile == "minimal" && !is_allowed_minimal_path(&rel, ty.is_dir()) {
                continue;
            }

            if ty.is_dir() {
                collect_payload_files_recursive(root, &path, profile, out)?;
                continue;
            }
            if !ty.is_file() {
                continue;
            }

            let rel = rel.trim_start_matches('/').to_string();
            if !rel.is_empty() {
                out.insert(rel);
            }
        }

        Ok(())
    }

    fn write_payload_manifest(dst_root: &Path, copied_paths: &[String]) -> Result<(), String> {
        let mut entries: Vec<String> = copied_paths.to_vec();
        entries.sort();
        entries.dedup();

        let mut body = String::new();
        for rel in entries {
            body.push_str(&rel);
            body.push('\n');
        }

        let path = payload_manifest_path(dst_root);
        std::fs::write(&path, body)
            .map_err(|e| format!("Failed to write payload manifest {}: {}", path.display(), e))
    }

    fn write_payload_deploy_info(
        dst_root: &Path,
        src_root: &Path,
        profile: &str,
        engine_override: Option<(u32, u32)>,
        copied_count: usize,
    ) -> Result<(), String> {
        let mut body = String::new();
        body.push_str(&format!("profile={profile}\n"));
        if let Some((major, minor)) = engine_override {
            body.push_str(&format!("engine_override={major}.{minor}\n"));
        } else {
            body.push_str("engine_override=unknown\n");
        }
        body.push_str(&format!("copied_files={copied_count}\n"));
        body.push_str(&format!("source={}\n", src_root.display()));
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        body.push_str(&format!("deployed_unix={ts}\n"));

        let path = dst_root.join(PAYLOAD_DEPLOY_INFO_FILE);
        std::fs::write(&path, body)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
    }

    fn remove_path_if_exists(path: &Path, tolerate_locked_files: bool) -> Result<bool, String> {
        if !path.exists() {
            return Ok(false);
        }
        if path.is_dir() {
            match std::fs::remove_dir_all(path) {
                Ok(_) => Ok(true),
                Err(e) if tolerate_locked_files && is_permission_denied(&e) => {
                    log::warn!(
                        "bridge: skipping locked directory during sync: {} ({})",
                        path.display(),
                        e
                    );
                    Ok(false)
                }
                Err(e) => Err(format!(
                    "Failed to remove legacy directory {}: {}",
                    path.display(),
                    e
                )),
            }
        } else {
            match std::fs::remove_file(path) {
                Ok(_) => Ok(true),
                Err(e) if tolerate_locked_files && is_permission_denied(&e) => {
                    log::warn!(
                        "bridge: skipping locked file during sync: {} ({})",
                        path.display(),
                        e
                    );
                    Ok(false)
                }
                Err(e) => Err(format!(
                    "Failed to remove legacy file {}: {}",
                    path.display(),
                    e
                )),
            }
        }
    }

    fn prune_empty_parent_dirs(start: Option<&Path>, stop_at: &Path) {
        let mut current = start;
        while let Some(dir) = current {
            if dir == stop_at {
                break;
            }
            match std::fs::read_dir(dir) {
                Ok(mut entries) => {
                    if entries.next().is_some() {
                        break;
                    }
                    let _ = std::fs::remove_dir(dir);
                    current = dir.parent();
                }
                Err(_) => break,
            }
        }
    }

    fn copy_dir_recursive(
        src: &Path,
        dst: &Path,
        src_root: &Path,
        profile: &str,
        tolerate_locked_files: bool,
        copied_paths: &mut Vec<String>,
    ) -> Result<usize, String> {
        if !src.is_dir() {
            return Err(format!(
                "Payload source is not a directory: {}",
                src.display()
            ));
        }
        std::fs::create_dir_all(dst)
            .map_err(|e| format!("Failed to create {}: {}", dst.display(), e))?;

        let mut copied = 0usize;
        let entries = std::fs::read_dir(src)
            .map_err(|e| format!("Failed to enumerate {}: {}", src.display(), e))?;

        for entry in entries {
            let entry = entry
                .map_err(|e| format!("Failed to read dir entry in {}: {}", src.display(), e))?;
            let src_path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == ".gitkeep" || name_str.ends_with(".md") {
                continue;
            }
            let rel = src_path
                .strip_prefix(src_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| String::new());
            let dst_path = dst.join(name);
            let ty = entry.file_type().map_err(|e| {
                format!("Failed to get file type for {}: {}", src_path.display(), e)
            })?;

            if profile == "minimal" && !is_allowed_minimal_path(&rel, ty.is_dir()) {
                continue;
            }

            if ty.is_dir() {
                copied += copy_dir_recursive(
                    &src_path,
                    &dst_path,
                    src_root,
                    profile,
                    tolerate_locked_files,
                    copied_paths,
                )?;
                continue;
            }
            if !ty.is_file() {
                continue;
            }

            if let Some(parent) = dst_path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    if tolerate_locked_files && is_permission_denied(&e) {
                        log::warn!(
                            "bridge: skipping locked parent dir during sync: {} ({})",
                            parent.display(),
                            e
                        );
                        continue;
                    }
                    return Err(format!(
                        "Failed to create parent {}: {}",
                        parent.display(),
                        e
                    ));
                }
            }
            if let Err(e) = std::fs::copy(&src_path, &dst_path) {
                if tolerate_locked_files && is_permission_denied(&e) {
                    log::warn!(
                        "bridge: skipping locked file copy during sync: {} -> {} ({})",
                        src_path.display(),
                        dst_path.display(),
                        e
                    );
                    // Keep tracked in manifest for next restart cleanup/update.
                    if let Ok(rel) = src_path.strip_prefix(src_root) {
                        let rel = rel
                            .to_string_lossy()
                            .replace('\\', "/")
                            .trim_start_matches('/')
                            .to_string();
                        if !rel.is_empty() {
                            copied_paths.push(rel);
                        }
                    }
                    continue;
                }
                return Err(format!(
                    "Failed to copy {} -> {}: {}",
                    src_path.display(),
                    dst_path.display(),
                    e
                ));
            }

            if let Ok(rel) = src_path.strip_prefix(src_root) {
                let rel = rel
                    .to_string_lossy()
                    .replace('\\', "/")
                    .trim_start_matches('/')
                    .to_string();
                if !rel.is_empty() {
                    copied_paths.push(rel);
                }
            }
            copied += 1;
        }

        Ok(copied)
    }

    fn is_permission_denied(e: &std::io::Error) -> bool {
        e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(5)
    }

    fn is_allowed_minimal_path(rel: &str, is_dir: bool) -> bool {
        if rel.is_empty() {
            return true;
        }
        // Top-level required runtime pieces.
        if rel == "UE4SS.dll"
            || rel == "UE4SS-settings.ini"
            || rel == "kovaaks_rust_core.dll"
            || rel == PAYLOAD_PROFILE_FILE
        {
            return true;
        }

        // Root dirs we intentionally keep for signatures/layout templates.
        if rel == "UE4SS_Signatures"
            || rel.starts_with("UE4SS_Signatures/")
            || rel == "VTableLayoutTemplates"
            || rel.starts_with("VTableLayoutTemplates/")
            || rel == "MemberVarLayoutTemplates"
            || rel.starts_with("MemberVarLayoutTemplates/")
        {
            return true;
        }

        // Managed mod + mods manifest only.
        if rel == "Mods" && is_dir {
            return true;
        }
        if rel == "Mods/mods.txt" {
            return true;
        }
        if rel == "Mods/KovaaksBridgeMod" || rel.starts_with("Mods/KovaaksBridgeMod/") {
            return true;
        }

        false
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub fn start(app: tauri::AppHandle) {
    imp::start(app);
}

#[cfg(not(target_os = "windows"))]
pub fn start(_app: tauri::AppHandle) {}

#[cfg(target_os = "windows")]
pub fn inject(dll_path: &str) -> Result<(), String> {
    imp::inject(dll_path)
}

#[cfg(not(target_os = "windows"))]
pub fn inject(_dll_path: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn deploy_and_inject(resource_dir: &std::path::Path, stats_dir: &str) -> Result<(), String> {
    imp::deploy_and_inject(resource_dir, stats_dir)
}

#[cfg(not(target_os = "windows"))]
pub fn deploy_and_inject(_resource_dir: &std::path::Path, _stats_dir: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn start_log_tailer(app: tauri::AppHandle, stats_dir: &str) -> Result<(), String> {
    imp::start_log_tailer(app, stats_dir)
}

#[cfg(not(target_os = "windows"))]
pub fn start_log_tailer(_app: tauri::AppHandle, _stats_dir: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn recent_logs(limit: usize) -> Vec<String> {
    imp::recent_logs(limit)
}

#[cfg(not(target_os = "windows"))]
pub fn recent_logs(_limit: usize) -> Vec<String> {
    Vec::new()
}

#[cfg(target_os = "windows")]
pub fn trigger_hot_reload() -> Result<(), String> {
    imp::trigger_hot_reload()
}

#[cfg(not(target_os = "windows"))]
pub fn trigger_hot_reload() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn get_runtime_flags(stats_dir: &str) -> Result<RuntimeFlagState, String> {
    imp::get_runtime_flags(stats_dir)
}

#[cfg(not(target_os = "windows"))]
pub fn get_runtime_flags(_stats_dir: &str) -> Result<RuntimeFlagState, String> {
    Ok(RuntimeFlagState {
        profile: "unsupported".to_string(),
        enable_pe_hook: false,
        disable_pe_hook: false,
        discovery: false,
        safe_mode: false,
        no_rust: false,
        log_all_events: false,
        object_debug: false,
        non_ui_probe: false,
        ui_counter_fallback: false,
        score_ui_fallback: false,
        hook_process_internal: false,
        hook_process_local_script: false,
        class_probe_hooks: false,
        allow_unsafe_hooks: false,
        native_hooks: false,
        hook_process_event: false,
        ui_settext_hook: false,
    })
}

#[cfg(target_os = "windows")]
pub fn set_runtime_flag(stats_dir: &str, key: &str, enabled: bool) -> Result<(), String> {
    imp::set_runtime_flag(stats_dir, key, enabled)
}

#[cfg(not(target_os = "windows"))]
pub fn set_runtime_flag(_stats_dir: &str, _key: &str, _enabled: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn request_runtime_flag_reload(stats_dir: &str) -> Result<(), String> {
    imp::request_runtime_flag_reload(stats_dir)
}

#[cfg(not(target_os = "windows"))]
pub fn request_runtime_flag_reload(_stats_dir: &str) -> Result<(), String> {
    Ok(())
}
