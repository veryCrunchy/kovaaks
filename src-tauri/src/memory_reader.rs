/// Live memory reader for KovaaK's FPSAimTrainer-Win64-Shipping.exe.
///
/// Reads live in-game stats via Windows ReadProcessMemory using confirmed
/// pointer chains from the BETA branch.  All offsets are relative to the
/// `FPSAimTrainer-Win64-Shipping.exe` module base to survive ASLR.
///
/// Pointer chain summary:
///   p1    = readQword(base + 0x4F5FBF0)
///   p2    = readQword(p1  + 0x0)          — PlayerController
///   p3    = readQword(p2  + 0x118)
///   p4    = readQword(p3  + 0x120)
///   stats = readQword(p4  + 0x28)         — stats object (availability TBD)
///
/// Confirmed from p2 (PlayerController):
///   kills (i32)   @ p2 + 0x9C8  — kill count, resets on scenario end
///   tgt   (i32)   @ p2 + 0x9D8  — unknown; observed as kills+1
///   session_time (f32) @ p2 + 0xA74  — total session time (seconds); freezes between stats updates
///
/// From stats object (availability across scenario types unconfirmed):
///   shots_fired (i32) @ stats + 0x290  — stored ×10 in memory
///   body_damage (i32) @ stats + 0x288
///   potential_damage (f32) @ stats + 0x2AC
///   fov (f32)         @ stats + 0x384

#[cfg(all(target_os = "windows", feature = "ocr"))]
mod imp {
    use std::mem;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows::Win32::System::ProcessStatus::{
        EnumProcessModules, GetModuleBaseNameW, GetModuleInformation, MODULEINFO,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    const PROCESS_NAME: &str = "FPSAimTrainer-Win64-Shipping.exe";

    /// Offset from module base to the first pointer in the chain.
    const OFFSET_P1: u64 = 0x4F5F_BF0;

    /// Scenario name pointer chain (7 hops from game base).
    /// Chain: base+0x537EC68 → +0x50 → +0x98 → +0x718 → +0xD20 → +0x48 → +0x8 → +0xDC
    /// Terminal value is a char* (null-terminated ASCII) pointing to the active scenario name.
    const SCEN_NAME_BASE: u64 = 0x537_EC68;
    const SCEN_NAME_OFFSETS: &[u64] = &[0x50, 0x98, 0x718, 0xD20, 0x48, 0x8, 0xDC];

    pub const EVENT_LIVE_MEM_STATS: &str = "live-mem-stats";

    static RUNNING: AtomicBool = AtomicBool::new(false);

    // ─── Data types ────────────────────────────────────────────────────────────

    #[derive(serde::Serialize, Clone, Debug)]
    pub struct LiveMemStats {
        /// p2 + 0x9C8 — kill count, resets on scenario end.
        pub kills: i32,
        /// p2 + 0x9D8 — unknown; observed as kills+1.
        pub tgt: i32,
        /// p2 + 0xA74 — total session time (seconds); freezes between stats updates (shots etc).
        pub session_time: f32,
        /// stats + 0x290 / 10 — shots fired (availability across scenario types unconfirmed).
        pub shots_fired: i32,
        /// stats + 0x288 — body damage (availability across scenario types unconfirmed).
        pub body_damage: i32,
        /// stats + 0x2AC — potential damage (availability across scenario types unconfirmed).
        pub potential_damage: f32,
        /// stats + 0x384 — FOV (availability across scenario types unconfirmed).
        pub fov: f32,
        /// Active scenario name read via 7-hop pointer chain from game base.
        /// Empty string when chain fails or game not running.
        pub scenario_name: String,
        /// True when a KovaaK's process was found and the chain resolved.
        pub connected: bool,
    }

    // ─── Safe memory reading helpers ──────────────────────────────────────────

    fn read_qword(handle: HANDLE, addr: u64) -> Option<u64> {
        let mut buf = [0u8; 8];
        let mut read = 0usize;
        let ok = unsafe {
            ReadProcessMemory(
                handle,
                addr as *const _,
                buf.as_mut_ptr() as *mut _,
                8,
                Some(&mut read),
            )
        };
        if ok.is_ok() && read == 8 {
            Some(u64::from_le_bytes(buf))
        } else {
            None
        }
    }

    fn read_i32(handle: HANDLE, addr: u64) -> Option<i32> {
        let mut buf = [0u8; 4];
        let mut read = 0usize;
        let ok = unsafe {
            ReadProcessMemory(
                handle,
                addr as *const _,
                buf.as_mut_ptr() as *mut _,
                4,
                Some(&mut read),
            )
        };
        if ok.is_ok() && read == 4 {
            Some(i32::from_le_bytes(buf))
        } else {
            None
        }
    }

    fn read_f32(handle: HANDLE, addr: u64) -> Option<f32> {
        let mut buf = [0u8; 4];
        let mut read = 0usize;
        let ok = unsafe {
            ReadProcessMemory(
                handle,
                addr as *const _,
                buf.as_mut_ptr() as *mut _,
                4,
                Some(&mut read),
            )
        };
        if ok.is_ok() && read == 4 {
            Some(f32::from_le_bytes(buf))
        } else {
            None
        }
    }

    fn read_bytes(handle: HANDLE, addr: u64, count: usize) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; count];
        let mut read = 0usize;
        let ok = unsafe {
            ReadProcessMemory(
                handle,
                addr as *const _,
                buf.as_mut_ptr() as *mut _,
                count,
                Some(&mut read),
            )
        };
        if ok.is_ok() && read > 0 {
            buf.truncate(read);
            Some(buf)
        } else {
            None
        }
    }

    /// Follow SCEN_NAME_OFFSETS chain and read the null-terminated ASCII scenario name.
    /// Returns an empty string if any step in the chain fails or gives a null pointer.
    fn read_scenario_name(handle: HANDLE, base: u64) -> String {
        let mut ptr = match read_qword(handle, base + SCEN_NAME_BASE) {
            Some(p) if p != 0 => p,
            _ => return String::new(),
        };
        for &offset in SCEN_NAME_OFFSETS {
            ptr = match read_qword(handle, ptr + offset) {
                Some(p) if p != 0 => p,
                _ => return String::new(),
            };
        }
        // ptr is now the char* address of the null-terminated ASCII scenario name
        let bytes = read_bytes(handle, ptr, 256).unwrap_or_default();
        let null_pos = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
        let s = String::from_utf8_lossy(&bytes[..null_pos]).into_owned();
        // Sanity: reject obviously garbage reads (non-printable majority)
        let printable = s
            .chars()
            .filter(|c| c.is_ascii_graphic() || *c == ' ')
            .count();
        if s.is_empty() || (printable * 2 < s.len()) {
            String::new()
        } else {
            s
        }
    }

    // ─── Process / module helpers ──────────────────────────────────────────────

    /// Find the PID of FPSAimTrainer.  Returns None if the process is not running.
    fn find_game_pid() -> Option<u32> {
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        };

        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()? };
        let mut entry: PROCESSENTRY32W = unsafe { mem::zeroed() };
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;

        let target: Vec<u16> = PROCESS_NAME.encode_utf16().collect();

        let mut pid = None;
        if unsafe { Process32FirstW(snap, &mut entry).is_ok() } {
            loop {
                let name_end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                if entry.szExeFile[..name_end] == target[..] {
                    pid = Some(entry.th32ProcessID);
                    break;
                }
                if unsafe { Process32NextW(snap, &mut entry).is_err() } {
                    break;
                }
            }
        }
        unsafe {
            let _ = CloseHandle(snap);
        }
        pid
    }

    /// Open the game process and return the handle + module base address.
    fn open_game(pid: u32) -> Option<(HANDLE, u64)> {
        let handle =
            unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid).ok()? };

        // Enumerate modules to find the main EXE base
        let mut modules = [windows::Win32::Foundation::HMODULE::default(); 1024];
        let mut needed = 0u32;
        let ok = unsafe {
            EnumProcessModules(
                handle,
                modules.as_mut_ptr(),
                (modules.len() * mem::size_of::<windows::Win32::Foundation::HMODULE>()) as u32,
                &mut needed,
            )
        };
        if ok.is_err() {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return None;
        }

        let count = needed as usize / mem::size_of::<windows::Win32::Foundation::HMODULE>();
        let target: Vec<u16> = PROCESS_NAME.encode_utf16().collect();

        for &module in &modules[..count] {
            let mut name = [0u16; 260];
            let len = unsafe { GetModuleBaseNameW(handle, Some(module), &mut name) } as usize;
            if len == 0 {
                continue;
            }
            if name[..len] == target[..] {
                let mut info: MODULEINFO = unsafe { mem::zeroed() };
                let ok = unsafe {
                    GetModuleInformation(
                        handle,
                        module,
                        &mut info,
                        mem::size_of::<MODULEINFO>() as u32,
                    )
                };
                if ok.is_ok() {
                    let base = info.lpBaseOfDll as u64;
                    return Some((handle, base));
                }
            }
        }

        unsafe {
            let _ = CloseHandle(handle);
        }
        None
    }

    // ─── Pointer chain walker ─────────────────────────────────────────────────

    /// Walk the pointer chain and return live stats.
    /// Returns a disconnected snapshot if anything fails.
    fn read_stats(handle: HANDLE, base: u64) -> LiveMemStats {
        let disconnected = LiveMemStats {
            kills: 0,
            tgt: 0,
            session_time: 0.0,
            shots_fired: 0,
            body_damage: 0,
            potential_damage: 0.0,
            fov: 0.0,
            scenario_name: String::new(),
            connected: false,
        };

        let Some(p1) = read_qword(handle, base + OFFSET_P1) else {
            return disconnected;
        };
        if p1 == 0 {
            return disconnected;
        }

        let Some(p2) = read_qword(handle, p1) else {
            return disconnected;
        };
        if p2 == 0 {
            return disconnected;
        }

        // p2 fields — confirmed
        let kills = read_i32(handle, p2 + 0x9C8).unwrap_or(0).clamp(0, 10_000);
        let tgt = read_i32(handle, p2 + 0x9D8).unwrap_or(0).clamp(0, 10_000);
        let session_time = {
            let v = read_f32(handle, p2 + 0xA74).unwrap_or(0.0);
            if v.is_nan() || v.is_infinite() {
                0.0
            } else {
                v
            }
        };

        // stats chain — follow regardless of scenario type; zero-out if chain fails
        let (shots_fired, body_damage, potential_damage, fov) = 'stats: {
            let Some(p3) = read_qword(handle, p2 + 0x118) else {
                break 'stats (0, 0, 0.0, 0.0);
            };
            if p3 == 0 {
                break 'stats (0, 0, 0.0, 0.0);
            }
            let Some(p4) = read_qword(handle, p3 + 0x120) else {
                break 'stats (0, 0, 0.0, 0.0);
            };
            if p4 == 0 {
                break 'stats (0, 0, 0.0, 0.0);
            }
            let Some(stats) = read_qword(handle, p4 + 0x28) else {
                break 'stats (0, 0, 0.0, 0.0);
            };
            if stats == 0 {
                break 'stats (0, 0, 0.0, 0.0);
            }

            let shots = (read_i32(handle, stats + 0x290).unwrap_or(0) / 10).clamp(0, 100_000);
            let damage = read_i32(handle, stats + 0x288)
                .unwrap_or(0)
                .clamp(0, 10_000_000);
            let pot_dmg = {
                let v = read_f32(handle, stats + 0x2AC).unwrap_or(0.0);
                if v.is_nan() || v.is_infinite() {
                    0.0
                } else {
                    v
                }
            };
            let fov_val = {
                let v = read_f32(handle, stats + 0x384).unwrap_or(0.0);
                if v.is_nan() || v.is_infinite() {
                    0.0
                } else {
                    v
                }
            };

            (shots, damage, pot_dmg, fov_val)
        };

        let scenario_name = read_scenario_name(handle, base);

        LiveMemStats {
            kills,
            tgt,
            session_time,
            shots_fired,
            body_damage,
            potential_damage,
            fov,
            scenario_name,
            connected: true,
        }
    }

    // ─── Background poll loop ─────────────────────────────────────────────────

    pub fn start(app: AppHandle) {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return; // already running
        }

        std::thread::Builder::new()
            .name("mem-reader".into())
            .spawn(move || {
                log::info!("Memory reader thread started");

                // State carried across iterations to avoid reopening the process every tick
                let mut cached: Option<(u32, HANDLE, u64)> = None; // (pid, handle, base)

                while RUNNING.load(Ordering::Relaxed) {
                    // Re-check process every tick; if PID changes, reopen.
                    let pid = find_game_pid();

                    let stats = match pid {
                        None => {
                            // Game not running — close stale handle if any
                            if let Some((_, handle, _)) = cached.take() {
                                unsafe {
                                    let _ = CloseHandle(handle);
                                }
                            }
                            LiveMemStats {
                                kills: 0,
                                tgt: 0,
                                session_time: 0.0,
                                shots_fired: 0,
                                body_damage: 0,
                                potential_damage: 0.0,
                                fov: 0.0,
                                scenario_name: String::new(),
                                connected: false,
                            }
                        }
                        Some(pid) => {
                            // Invalidate cache if PID changed (game restarted)
                            if let Some((cached_pid, handle, _)) = cached {
                                if cached_pid != pid {
                                    unsafe {
                                        let _ = CloseHandle(handle);
                                    }
                                    cached = None;
                                }
                            }

                            // Open if not cached
                            if cached.is_none() {
                                if let Some((handle, base)) = open_game(pid) {
                                    log::info!(
                                        "Memory reader: attached to game PID={pid} base=0x{base:X}"
                                    );
                                    cached = Some((pid, handle, base));
                                }
                            }

                            match &cached {
                                Some((_, handle, base)) => read_stats(*handle, *base),
                                None => LiveMemStats {
                                    kills: 0,
                                    tgt: 0,
                                    session_time: 0.0,
                                    shots_fired: 0,
                                    body_damage: 0,
                                    potential_damage: 0.0,
                                    fov: 0.0,
                                    scenario_name: String::new(),
                                    connected: false,
                                },
                            }
                        }
                    };

                    if let Err(e) = app.emit(EVENT_LIVE_MEM_STATS, &stats) {
                        log::warn!("mem-reader emit error: {e}");
                    }

                    std::thread::sleep(Duration::from_millis(33)); // ~30 Hz
                }

                // Clean up
                if let Some((_, handle, _)) = cached.take() {
                    unsafe {
                        let _ = CloseHandle(handle);
                    }
                }
                log::info!("Memory reader thread stopped");
            })
            .expect("failed to spawn mem-reader thread");
    }

    pub fn stop() {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

// ─── Public re-exports (platform-gated) ──────────────────────────────────────

#[cfg(all(target_os = "windows", feature = "ocr"))]
pub use imp::start;

/// On non-Windows / non-OCR builds these are no-ops so lib.rs compiles everywhere.
#[cfg(not(all(target_os = "windows", feature = "ocr")))]
pub fn start(_app: tauri::AppHandle) {}

#[cfg(not(all(target_os = "windows", feature = "ocr")))]
pub fn stop() {}
