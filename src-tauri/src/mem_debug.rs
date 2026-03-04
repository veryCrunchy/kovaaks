/// Memory debug commands — one-shot reads, value scanner, pointer chain follower.
///
/// All heavy lifting is gated behind `#[cfg(all(target_os = "windows", feature = "ocr"))]`.
/// Stub implementations (returning errors) exist on other platforms so lib.rs compiles
/// everywhere without conditional registrations.
use std::sync::atomic::{AtomicBool, Ordering};

/// Set to true by `mem_scan_cancel`; checked every region during scan.
static SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

pub const EVENT_SCAN_PROGRESS: &str = "mem-scan-progress";
pub const EVENT_PTR_SCAN_PROGRESS: &str = "mem-ptr-scan-progress";
pub const EVENT_AUTO_CHAIN_PROGRESS: &str = "mem-auto-chain-progress";

/// Progress payload for the automated multi-level pointer chain finder.
#[derive(serde::Serialize, Clone, Debug)]
pub struct AutoChainProgress {
    /// 0 = building pointer index (scanning all memory), 1 = BFS search
    pub phase: u8,
    /// Overall 0-100 progress estimate.
    pub pct: u8,
    /// Number of pointer-like values collected in the index (available once phase 1 starts).
    pub index_size: usize,
    pub chains_found: usize,
    pub done: bool,
    pub error: Option<String>,
}

/// Progress payload emitted to the frontend during and after a scan.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ScanProgress {
    pub scanned_mb: u32,
    pub hits: usize,
    /// Approximate 0-100 based on address space coverage (not wall time).
    pub pct: u8,
    pub done: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

// ─── Windows implementation ───────────────────────────────────────────────────

#[cfg(all(target_os = "windows", feature = "ocr"))]
mod imp {
    use std::mem;
    use std::sync::atomic::{AtomicBool, Ordering};

    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Memory::{
        MEM_COMMIT, MEMORY_BASIC_INFORMATION, PAGE_GUARD, PAGE_NOACCESS, PAGE_READWRITE,
        PAGE_WRITECOPY, VirtualQueryEx,
    };
    use windows::Win32::System::ProcessStatus::{
        EnumProcessModules, GetModuleBaseNameW, GetModuleInformation, MODULEINFO,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    const PROCESS_NAME: &str = "FPSAimTrainer-Win64-Shipping.exe";

    // ─── Shared data types ────────────────────────────────────────────────────

    #[derive(serde::Serialize, Clone, Debug)]
    pub struct ScanHit {
        pub addr: String,
        pub value: f64,
        pub module_rel: Option<String>,
    }

    #[derive(serde::Serialize, Clone, Debug)]
    pub struct ChainStep {
        pub label: String,
        pub addr: String,
        pub ptr_value: String,
        pub ok: bool,
    }

    #[derive(serde::Serialize, Clone, Debug)]
    pub struct ChainResult {
        pub steps: Vec<ChainStep>,
        pub final_addr: Option<String>,
        pub final_value: Option<f64>,
        pub ok: bool,
        pub error: Option<String>,
    }

    #[derive(serde::Serialize, Clone, Debug)]
    pub struct ModuleEntry {
        pub name: String,
        pub base: String,
        pub size: u32,
    }

    #[derive(serde::Deserialize, Clone, Debug)]
    pub struct WatchRequest {
        pub value_type: String,
        pub addr_hex: Option<String>,
        pub chain: Option<Vec<String>>,
    }

    #[derive(serde::Serialize, Clone, Debug)]
    pub struct WatchResult {
        pub value: Option<f64>,
        pub addr: Option<String>,
        pub ok: bool,
        pub error: Option<String>,
    }

    // ─── Process helpers ──────────────────────────────────────────────────────

    fn find_game_pid() -> Option<u32> {
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()? };
        let mut entry: PROCESSENTRY32W = unsafe { mem::zeroed() };
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
        let target: Vec<u16> = PROCESS_NAME.encode_utf16().collect();
        let mut pid = None;
        if unsafe { Process32FirstW(snap, &mut entry).is_ok() } {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                if entry.szExeFile[..end] == target[..] {
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

    fn open_game(pid: u32) -> Option<(HANDLE, u64)> {
        let handle =
            unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid).ok()? };
        let mut mods = [windows::Win32::Foundation::HMODULE::default(); 1024];
        let mut needed = 0u32;
        if unsafe {
            EnumProcessModules(
                handle,
                mods.as_mut_ptr(),
                (mods.len() * mem::size_of::<windows::Win32::Foundation::HMODULE>()) as u32,
                &mut needed,
            )
        }
        .is_err()
        {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return None;
        }
        let count = needed as usize / mem::size_of::<windows::Win32::Foundation::HMODULE>();
        let target: Vec<u16> = PROCESS_NAME.encode_utf16().collect();
        for &m in &mods[..count] {
            let mut name = [0u16; 260];
            let len = unsafe { GetModuleBaseNameW(handle, Some(m), &mut name) } as usize;
            if len > 0 && name[..len] == target[..] {
                let mut info: MODULEINFO = unsafe { mem::zeroed() };
                if unsafe {
                    GetModuleInformation(handle, m, &mut info, mem::size_of::<MODULEINFO>() as u32)
                }
                .is_ok()
                {
                    return Some((handle, info.lpBaseOfDll as u64));
                }
            }
        }
        unsafe {
            let _ = CloseHandle(handle);
        }
        None
    }

    fn list_modules(handle: HANDLE) -> Vec<ModuleEntry> {
        let mut mods = [windows::Win32::Foundation::HMODULE::default(); 512];
        let mut needed = 0u32;
        if unsafe {
            EnumProcessModules(
                handle,
                mods.as_mut_ptr(),
                (mods.len() * mem::size_of::<windows::Win32::Foundation::HMODULE>()) as u32,
                &mut needed,
            )
        }
        .is_err()
        {
            return vec![];
        }
        let count = needed as usize / mem::size_of::<windows::Win32::Foundation::HMODULE>();
        let mut out = Vec::new();
        for &m in &mods[..count] {
            let mut name = [0u16; 260];
            let len = unsafe { GetModuleBaseNameW(handle, Some(m), &mut name) } as usize;
            if len == 0 {
                continue;
            }
            let name_s = String::from_utf16_lossy(&name[..len]);
            let mut info: MODULEINFO = unsafe { mem::zeroed() };
            if unsafe {
                GetModuleInformation(handle, m, &mut info, mem::size_of::<MODULEINFO>() as u32)
            }
            .is_ok()
            {
                out.push(ModuleEntry {
                    name: name_s,
                    base: format!("0x{:X}", info.lpBaseOfDll as u64),
                    size: info.SizeOfImage,
                });
            }
        }
        out
    }

    fn resolve_module_rel(addr: u64, modules: &[ModuleEntry]) -> Option<String> {
        for m in modules {
            let base = parse_hex(&m.base).ok()?;
            if addr >= base && addr < base + m.size as u64 {
                return Some(format!("{}+0x{:X}", m.name, addr - base));
            }
        }
        None
    }

    // ─── Low-level read helpers ───────────────────────────────────────────────

    pub fn parse_hex(s: &str) -> Result<u64, String> {
        let s = s.trim().trim_start_matches("0x").trim_start_matches("0X");
        u64::from_str_radix(s, 16).map_err(|e| format!("bad hex \"{s}\": {e}"))
    }

    fn read_raw(handle: HANDLE, addr: u64, count: usize) -> Option<Vec<u8>> {
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
        if ok.is_ok() && read == count {
            Some(buf)
        } else {
            None
        }
    }

    fn read_qword(handle: HANDLE, addr: u64) -> Option<u64> {
        read_raw(handle, addr, 8).map(|b| u64::from_le_bytes(b.try_into().unwrap()))
    }

    // ─── Value codec ──────────────────────────────────────────────────────────

    fn type_size(t: &str) -> usize {
        match t {
            "u8" | "i8" => 1,
            "u16" | "i16" => 2,
            "u32" | "i32" | "f32" => 4,
            "u64" | "i64" | "f64" => 8,
            _ => 4,
        }
    }

    fn decode(buf: &[u8], t: &str) -> f64 {
        match t {
            "u8" => buf[0] as f64,
            "i8" => buf[0] as i8 as f64,
            "u16" => u16::from_le_bytes(buf[..2].try_into().unwrap_or_default()) as f64,
            "i16" => i16::from_le_bytes(buf[..2].try_into().unwrap_or_default()) as f64,
            "u32" => u32::from_le_bytes(buf[..4].try_into().unwrap_or_default()) as f64,
            "i32" => i32::from_le_bytes(buf[..4].try_into().unwrap_or_default()) as f64,
            "f32" => f32::from_le_bytes(buf[..4].try_into().unwrap_or_default()) as f64,
            "u64" => u64::from_le_bytes(buf[..8].try_into().unwrap_or_default()) as f64,
            "i64" => i64::from_le_bytes(buf[..8].try_into().unwrap_or_default()) as f64,
            "f64" => f64::from_le_bytes(buf[..8].try_into().unwrap_or_default()),
            _ => 0.0,
        }
    }

    fn encode(val: f64, t: &str) -> Vec<u8> {
        match t {
            "u8" => vec![val as u8],
            "i8" => (val as i8).to_le_bytes().to_vec(),
            "u16" => (val as u16).to_le_bytes().to_vec(),
            "i16" => (val as i16).to_le_bytes().to_vec(),
            "u32" => (val as u32).to_le_bytes().to_vec(),
            "i32" => (val as i32).to_le_bytes().to_vec(),
            "f32" => (val as f32).to_le_bytes().to_vec(),
            "u64" => (val as u64).to_le_bytes().to_vec(),
            "i64" => (val as i64).to_le_bytes().to_vec(),
            "f64" => val.to_le_bytes().to_vec(),
            _ => (val as i32).to_le_bytes().to_vec(),
        }
    }

    fn value_matches(buf: &[u8], t: &str, target_bytes: &[u8], target_f64: f64) -> bool {
        if t.starts_with('f') {
            let v = decode(buf, t);
            if v.is_nan() || v.is_infinite() {
                return false;
            }
            // Tolerance: 0.1% relative or 0.001 absolute
            let eps = (target_f64.abs() * 0.001).max(0.001);
            (v - target_f64).abs() <= eps
        } else {
            buf == target_bytes
        }
    }

    // ─── Command implementations ──────────────────────────────────────────────

    pub fn read_watches(requests: Vec<WatchRequest>) -> Vec<WatchResult> {
        let pid = match find_game_pid() {
            Some(p) => p,
            None => {
                return requests
                    .iter()
                    .map(|_| WatchResult {
                        value: None,
                        addr: None,
                        ok: false,
                        error: Some("Game not running".into()),
                    })
                    .collect();
            }
        };
        let (handle, base) = match open_game(pid) {
            Some(h) => h,
            None => {
                return requests
                    .iter()
                    .map(|_| WatchResult {
                        value: None,
                        addr: None,
                        ok: false,
                        error: Some("Failed to open process".into()),
                    })
                    .collect();
            }
        };

        let results = requests
            .iter()
            .map(|req| resolve_watch(handle, base, req))
            .collect();

        unsafe {
            let _ = CloseHandle(handle);
        }
        results
    }

    fn resolve_watch(handle: HANDLE, game_base: u64, req: &WatchRequest) -> WatchResult {
        // Chain takes priority over raw addr
        if let Some(chain) = &req.chain {
            return resolve_chain_watch(handle, game_base, chain, &req.value_type);
        }
        if let Some(addr_hex) = &req.addr_hex {
            return resolve_addr_watch(handle, addr_hex, &req.value_type);
        }
        WatchResult {
            value: None,
            addr: None,
            ok: false,
            error: Some("No addr or chain".into()),
        }
    }

    fn resolve_addr_watch(handle: HANDLE, addr_hex: &str, vtype: &str) -> WatchResult {
        let addr = match parse_hex(addr_hex) {
            Ok(a) => a,
            Err(e) => {
                return WatchResult {
                    value: None,
                    addr: None,
                    ok: false,
                    error: Some(e),
                };
            }
        };
        let size = type_size(vtype);
        match read_raw(handle, addr, size) {
            Some(buf) => {
                let v = decode(&buf, vtype);
                WatchResult {
                    value: Some(v),
                    addr: Some(format!("0x{addr:X}")),
                    ok: true,
                    error: None,
                }
            }
            None => WatchResult {
                value: None,
                addr: Some(format!("0x{addr:X}")),
                ok: false,
                error: Some("Read failed".into()),
            },
        }
    }

    /// Follow a pointer chain from game_base.
    /// offsets[0..N-2] are dereferenced as qwords.
    /// offsets[N-1] is added to get the final address, then value_type is read.
    fn resolve_chain_watch(
        handle: HANDLE,
        game_base: u64,
        offsets: &[String],
        vtype: &str,
    ) -> WatchResult {
        if offsets.is_empty() {
            return WatchResult {
                value: None,
                addr: None,
                ok: false,
                error: Some("Empty chain".into()),
            };
        }
        let parsed: Vec<u64> = match offsets
            .iter()
            .map(|s| parse_hex(s))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(v) => v,
            Err(e) => {
                return WatchResult {
                    value: None,
                    addr: None,
                    ok: false,
                    error: Some(e),
                };
            }
        };

        let n = parsed.len();
        let mut ptr = game_base;

        // Dereference all but the last offset
        for &off in &parsed[..n - 1] {
            ptr = match read_qword(handle, ptr + off) {
                Some(p) if p != 0 => p,
                _ => {
                    return WatchResult {
                        value: None,
                        addr: None,
                        ok: false,
                        error: Some(format!("Null/failed at +0x{off:X}")),
                    };
                }
            };
        }

        // Final address = ptr + last offset
        let final_addr = ptr + parsed[n - 1];
        let size = type_size(vtype);
        match read_raw(handle, final_addr, size) {
            Some(buf) => {
                let v = decode(&buf, vtype);
                WatchResult {
                    value: Some(v),
                    addr: Some(format!("0x{final_addr:X}")),
                    ok: true,
                    error: None,
                }
            }
            None => WatchResult {
                value: None,
                addr: Some(format!("0x{final_addr:X}")),
                ok: false,
                error: Some("Read failed".into()),
            },
        }
    }

    /// Scan all committed PAGE_READWRITE regions for `target`.
    ///
    /// Safety guarantees vs the previous version:
    /// - Single pre-allocated 1 MB buffer (no per-chunk heap allocation).
    /// - Skips regions > 64 MB (mapped textures / video memory).
    /// - Checks `cancel` flag every region; bails immediately when set.
    /// - `progress_cb` is called after every MB of data read (non-blocking).
    pub fn scan<F>(
        value_type: String,
        target: f64,
        cancel: &AtomicBool,
        progress_cb: F,
    ) -> Result<Vec<ScanHit>, String>
    where
        F: Fn(u32, u8, usize), // (scanned_mb, pct, hits)
    {
        let pid = find_game_pid().ok_or("Game not running")?;
        let (handle, _base) = open_game(pid).ok_or("Failed to open process")?;
        let modules = list_modules(handle);

        let target_bytes = encode(target, &value_type);
        let size = type_size(&value_type);
        const MAX_HITS: usize = 2000;
        const CHUNK: usize = 1024 * 1024; // 1 MB — single reused buffer
        const MAX_REGION: usize = 64 * 1024 * 1024; // skip anything > 64 MB

        let mut hits = Vec::new();
        let mut addr: u64 = 0;
        let mut scanned_bytes: u64 = 0;
        let mut last_progress_mb: u32 = 0;
        // One buffer for the entire scan — avoids repeated large allocations.
        let mut chunk_buf: Vec<u8> = vec![0u8; CHUNK];

        'outer: loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            let mut mbi: MEMORY_BASIC_INFORMATION = unsafe { mem::zeroed() };
            let ret = unsafe {
                VirtualQueryEx(
                    handle,
                    Some(addr as *const _),
                    &mut mbi,
                    mem::size_of::<MEMORY_BASIC_INFORMATION>(),
                )
            };
            if ret == 0 {
                break; // past end of address space
            }

            let region_base = mbi.BaseAddress as u64;
            let region_size = mbi.RegionSize;
            // Guard: zero-size region would never advance addr → infinite loop.
            if region_size == 0 {
                addr = region_base.saturating_add(4096);
                continue;
            }
            addr = region_base.saturating_add(region_size as u64);
            if addr == 0 {
                break; // address wrapped — done
            }

            // Only scan committed, non-guarded, writable pages.
            // PAGE_READWRITE  = heap, stack, global BSS (already written)
            // PAGE_WRITECOPY  = PE .data sections not yet written (still hold static init values)
            if mbi.State != MEM_COMMIT {
                continue;
            }
            if mbi.Protect == PAGE_NOACCESS {
                continue;
            }
            if mbi.Protect.0 & PAGE_GUARD.0 != 0 {
                continue;
            }
            if mbi.Protect != PAGE_READWRITE && mbi.Protect != PAGE_WRITECOPY {
                continue;
            }
            // Large regions are texture buffers / mapped device memory — skip them.
            if region_size > MAX_REGION {
                continue;
            }

            let mut off = 0usize;
            while off < region_size {
                if cancel.load(Ordering::Relaxed) {
                    break 'outer;
                }

                let chunk = (region_size - off).min(CHUNK);
                // If the remaining tail is smaller than one value, nothing to scan here.
                if chunk < size {
                    break;
                }

                // Read directly into the reused buffer — no allocation.
                let mut bytes_read = 0usize;
                let ok = unsafe {
                    ReadProcessMemory(
                        handle,
                        (region_base + off as u64) as *const _,
                        chunk_buf.as_mut_ptr() as *mut _,
                        chunk,
                        Some(&mut bytes_read),
                    )
                };

                if ok.is_ok() && bytes_read >= size {
                    let scanlen = bytes_read - (size - 1);
                    let mut i = 0;
                    while i < scanlen {
                        if value_matches(
                            &chunk_buf[i..i + size],
                            &value_type,
                            &target_bytes,
                            target,
                        ) {
                            let hit_addr = region_base + off as u64 + i as u64;
                            hits.push(ScanHit {
                                addr: format!("0x{hit_addr:X}"),
                                value: decode(&chunk_buf[i..i + size], &value_type),
                                module_rel: resolve_module_rel(hit_addr, &modules),
                            });
                            if hits.len() >= MAX_HITS {
                                break;
                            }
                        }
                        i += 1;
                    }
                    scanned_bytes += bytes_read as u64;
                }

                if hits.len() >= MAX_HITS {
                    break 'outer;
                }
                // Advance by chunk minus the overlap needed to catch values spanning
                // chunk boundaries. chunk >= size so chunk - (size-1) >= 1 always.
                off += chunk - (size - 1);

                // Emit progress every 256 KB of data actually read.
                let scanned_mb_x4 = (scanned_bytes / (256 * 1024)) as u32;
                if scanned_mb_x4 > last_progress_mb {
                    last_progress_mb = scanned_mb_x4;
                    let scanned_mb = (scanned_bytes / (1024 * 1024)) as u32;
                    // Progress %: based on scanned bytes vs a ~1 GB reference ceiling.
                    // Better UX than address-space ratio which stays near 0 for most games.
                    const EXPECTED_BYTES: f64 = 1024.0 * 1024.0 * 1024.0;
                    let pct = ((scanned_bytes as f64 / EXPECTED_BYTES) * 100.0).min(99.0) as u8;
                    progress_cb(scanned_mb, pct, hits.len());
                }
            }
        }

        unsafe {
            let _ = CloseHandle(handle);
        }
        Ok(hits)
    }

    pub fn rescan(
        addrs: Vec<String>,
        value_type: String,
        target: f64,
    ) -> Result<Vec<ScanHit>, String> {
        let pid = find_game_pid().ok_or("Game not running")?;
        let (handle, _base) = open_game(pid).ok_or("Failed to open process")?;
        let modules = list_modules(handle);
        let target_bytes = encode(target, &value_type);
        let size = type_size(&value_type);

        let mut hits = Vec::new();
        for addr_hex in &addrs {
            let addr = match parse_hex(addr_hex) {
                Ok(a) => a,
                Err(_) => continue,
            };
            if let Some(buf) = read_raw(handle, addr, size) {
                if value_matches(&buf, &value_type, &target_bytes, target) {
                    hits.push(ScanHit {
                        addr: format!("0x{addr:X}"),
                        value: decode(&buf, &value_type),
                        module_rel: resolve_module_rel(addr, &modules),
                    });
                }
            }
        }
        unsafe {
            let _ = CloseHandle(handle);
        }
        Ok(hits)
    }

    // ─── Pointer scanner ──────────────────────────────────────────────────────

    #[derive(serde::Serialize, Clone, Debug)]
    pub struct PtrScanHit {
        /// Address of the pointer in memory.
        pub addr: String,
        /// The 8-byte value stored there (the pointer itself).
        pub ptr_value: String,
        /// target_addr - ptr_value  (offset into the pointed object).
        pub offset: u64,
        /// module+0xOFFSET if the pointer lives in a loaded module (static!).
        pub module_rel: Option<String>,
    }

    /// Scan all committed PAGE_READWRITE regions for 8-byte values in the range
    /// [target - max_back, target].  Only 8-byte aligned positions are checked
    /// since Windows pointers are always pointer-aligned.  Module-relative hits
    /// are stable across ASLR restarts and can be used as chain bases.
    pub fn ptr_scan<F>(
        target: u64,
        max_back: u64,
        cancel: &AtomicBool,
        progress_cb: F,
    ) -> Result<Vec<PtrScanHit>, String>
    where
        F: Fn(u32, u8, usize),
    {
        let pid = find_game_pid().ok_or("Game not running")?;
        let (handle, _base) = open_game(pid).ok_or("Failed to open process")?;
        let modules = list_modules(handle);

        let low = target.saturating_sub(max_back);
        const MAX_HITS: usize = 2000;
        const CHUNK: usize = 1024 * 1024;
        const MAX_REGION: usize = 64 * 1024 * 1024;

        let mut hits = Vec::new();
        let mut addr: u64 = 0;
        let mut scanned_bytes: u64 = 0;
        let mut last_progress = 0u32;
        let mut chunk_buf: Vec<u8> = vec![0u8; CHUNK];

        'outer: loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            let mut mbi: MEMORY_BASIC_INFORMATION = unsafe { mem::zeroed() };
            let ret = unsafe {
                VirtualQueryEx(
                    handle,
                    Some(addr as *const _),
                    &mut mbi,
                    mem::size_of::<MEMORY_BASIC_INFORMATION>(),
                )
            };
            if ret == 0 {
                break;
            }

            let region_base = mbi.BaseAddress as u64;
            let region_size = mbi.RegionSize;
            if region_size == 0 {
                addr = region_base.saturating_add(4096);
                continue;
            }
            addr = region_base.saturating_add(region_size as u64);
            if addr == 0 {
                break;
            }

            if mbi.State != MEM_COMMIT {
                continue;
            }
            if mbi.Protect == PAGE_NOACCESS {
                continue;
            }
            if mbi.Protect.0 & PAGE_GUARD.0 != 0 {
                continue;
            }
            if mbi.Protect != PAGE_READWRITE && mbi.Protect != PAGE_WRITECOPY {
                continue;
            }
            if region_size > MAX_REGION {
                continue;
            }

            let mut off = 0usize;
            while off < region_size {
                if cancel.load(Ordering::Relaxed) {
                    break 'outer;
                }

                let chunk = (region_size - off).min(CHUNK);
                if chunk < 8 {
                    break;
                }

                let mut bytes_read = 0usize;
                let ok = unsafe {
                    ReadProcessMemory(
                        handle,
                        (region_base + off as u64) as *const _,
                        chunk_buf.as_mut_ptr() as *mut _,
                        chunk,
                        Some(&mut bytes_read),
                    )
                };

                if ok.is_ok() && bytes_read >= 8 {
                    let base_addr = region_base + off as u64;
                    // Align scan start to 8-byte boundary
                    let align_adj = (8 - (base_addr % 8) as usize) % 8;
                    let mut i = align_adj;
                    while i + 8 <= bytes_read {
                        let v = u64::from_le_bytes(chunk_buf[i..i + 8].try_into().unwrap());
                        if v >= low && v <= target {
                            let hit_addr = base_addr + i as u64;
                            hits.push(PtrScanHit {
                                addr: format!("0x{hit_addr:X}"),
                                ptr_value: format!("0x{v:X}"),
                                offset: target - v,
                                module_rel: resolve_module_rel(hit_addr, &modules),
                            });
                            if hits.len() >= MAX_HITS {
                                break;
                            }
                        }
                        i += 8; // aligned step — no byte-by-byte needed for ptr scan
                    }
                    scanned_bytes += bytes_read as u64;
                }

                if hits.len() >= MAX_HITS {
                    break 'outer;
                }
                off += chunk; // no overlap needed — aligned 8-byte reads can't span chunks

                let mb_x4 = (scanned_bytes / (256 * 1024)) as u32;
                if mb_x4 > last_progress {
                    last_progress = mb_x4;
                    let mb = (scanned_bytes / (1024 * 1024)) as u32;
                    const EXPECTED: f64 = 1024.0 * 1024.0 * 1024.0;
                    let pct = ((scanned_bytes as f64 / EXPECTED) * 100.0).min(99.0) as u8;
                    progress_cb(mb, pct, hits.len());
                }
            }
        }

        unsafe {
            let _ = CloseHandle(handle);
        }
        Ok(hits)
    }

    // ─── Auto chain finder ────────────────────────────────────────────────────

    /// A found static pointer chain.
    /// `offsets[0]` = hex offset from game_base to the static pointer location.
    /// `offsets[1..depth-1]` = intermediate struct offsets (each dereferences a qword).
    /// `offsets[depth]` = final struct offset to the value.
    #[derive(serde::Serialize, Clone, Debug)]
    pub struct FoundChain {
        pub offsets: Vec<String>,
        pub module_rel: String,
        pub depth: usize,
    }

    #[derive(serde::Serialize, Clone, Debug)]
    pub struct AutoChainResult {
        pub target_addr: String,
        pub target_label: String,
        pub chains: Vec<FoundChain>,
    }

    /// In-memory sorted index of all pointer-like 8-byte values in the game process.
    /// Built once with a full memory scan; subsequent lookups are O(log N).
    struct PtrIndex {
        /// (ptr_value, ptr_containing_addr), sorted ascending by ptr_value.
        entries: Vec<(u64, u64)>,
    }

    const MIN_USERSPACE_PTR: u64 = 0x10000;
    const MAX_USERSPACE_PTR: u64 = 0x7FFF_FFFF_FFFF;

    impl PtrIndex {
        /// Scan all committed read/write pages and collect every 8-byte aligned value
        /// that looks like a valid user-space pointer.  Sorted by value on return.
        fn build<F>(handle: HANDLE, cancel: &AtomicBool, progress_cb: F) -> Result<Self, String>
        where
            F: Fn(u32, u8),
        {
            let mut entries: Vec<(u64, u64)> = Vec::with_capacity(500_000);
            let mut addr: u64 = 0;
            let mut scanned_bytes: u64 = 0;
            let mut last_progress = 0u32;
            const CHUNK: usize = 1024 * 1024;
            const MAX_REGION: usize = 64 * 1024 * 1024;
            let mut chunk_buf: Vec<u8> = vec![0u8; CHUNK];

            loop {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }

                let mut mbi: MEMORY_BASIC_INFORMATION = unsafe { mem::zeroed() };
                let ret = unsafe {
                    VirtualQueryEx(
                        handle,
                        Some(addr as *const _),
                        &mut mbi,
                        mem::size_of::<MEMORY_BASIC_INFORMATION>(),
                    )
                };
                if ret == 0 {
                    break;
                }

                let region_base = mbi.BaseAddress as u64;
                let region_size = mbi.RegionSize;
                if region_size == 0 {
                    addr = region_base.saturating_add(4096);
                    continue;
                }
                addr = region_base.saturating_add(region_size as u64);
                if addr == 0 {
                    break;
                }

                if mbi.State != MEM_COMMIT {
                    continue;
                }
                if mbi.Protect == PAGE_NOACCESS {
                    continue;
                }
                if mbi.Protect.0 & PAGE_GUARD.0 != 0 {
                    continue;
                }
                if mbi.Protect != PAGE_READWRITE && mbi.Protect != PAGE_WRITECOPY {
                    continue;
                }
                if region_size > MAX_REGION {
                    continue;
                }

                let mut off = 0usize;
                while off < region_size {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }

                    let chunk = (region_size - off).min(CHUNK);
                    if chunk < 8 {
                        break;
                    }

                    let mut bytes_read = 0usize;
                    let ok = unsafe {
                        ReadProcessMemory(
                            handle,
                            (region_base + off as u64) as *const _,
                            chunk_buf.as_mut_ptr() as *mut _,
                            chunk,
                            Some(&mut bytes_read),
                        )
                    };

                    if ok.is_ok() && bytes_read >= 8 {
                        let base_addr = region_base + off as u64;
                        let align_adj = (8 - (base_addr % 8) as usize) % 8;
                        let mut i = align_adj;
                        while i + 8 <= bytes_read {
                            let v = u64::from_le_bytes(chunk_buf[i..i + 8].try_into().unwrap());
                            if v >= MIN_USERSPACE_PTR && v <= MAX_USERSPACE_PTR {
                                entries.push((v, base_addr + i as u64));
                            }
                            i += 8;
                        }
                        scanned_bytes += bytes_read as u64;
                    }

                    off += chunk;

                    let mb_x4 = (scanned_bytes / (256 * 1024)) as u32;
                    if mb_x4 > last_progress {
                        last_progress = mb_x4;
                        let mb = (scanned_bytes / (1024 * 1024)) as u32;
                        const EXPECTED: f64 = 1024.0 * 1024.0 * 1024.0;
                        let pct = ((scanned_bytes as f64 / EXPECTED) * 100.0).min(99.0) as u8;
                        progress_cb(mb, pct);
                    }
                }
            }

            entries.sort_unstable_by_key(|e| e.0);
            Ok(PtrIndex { entries })
        }

        /// All entries (ptr_value, ptr_addr) where ptr_value ∈ [target - max_back, target].
        fn find_ptrs_to(&self, target: u64, max_back: u64) -> &[(u64, u64)] {
            let low = target.saturating_sub(max_back);
            let start = self.entries.partition_point(|e| e.0 < low);
            let end = self.entries.partition_point(|e| e.0 <= target);
            &self.entries[start..end]
        }

        fn len(&self) -> usize {
            self.entries.len()
        }
    }

    /// BFS multi-level pointer chain search.
    ///
    /// Starting from each target address, at each level we look up all pointers in the
    /// index that land within `max_back` bytes of the current frontier address.
    /// Static hits (pointer lives inside the game exe module) yield complete chains.
    /// Heap hits become the next level's frontier, capped at `max_heap_per_level`.
    fn find_chains_bfs(
        targets: &[(u64, String)],
        max_depth: usize,
        max_back: u64,
        max_heap_per_level: usize,
        modules: &[ModuleEntry],
        index: &PtrIndex,
        cancel: &AtomicBool,
    ) -> Vec<AutoChainResult> {
        let mut results: Vec<AutoChainResult> = targets
            .iter()
            .map(|(addr, label)| AutoChainResult {
                target_addr: format!("0x{addr:X}"),
                target_label: label.clone(),
                chains: vec![],
            })
            .collect();

        for (ti, (target_addr, _)) in targets.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            // BFS queue: (frontier addr, accumulated suffix offsets from frontier forward)
            // suffix[0] is the closest to the target, suffix.last() is the final struct offset.
            let mut queue: Vec<(u64, Vec<u64>)> = vec![(*target_addr, vec![])];
            let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
            seen.insert(*target_addr);

            for _level in 0..max_depth {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                if queue.is_empty() {
                    break;
                }

                let mut next_queue: Vec<(u64, Vec<u64>)> = Vec::new();

                'nodes: for (node_addr, suffix) in &queue {
                    for &(ptr_value, ptr_addr) in index.find_ptrs_to(*node_addr, max_back) {
                        // struct_off = distance from object base (ptr_value) to node_addr
                        let struct_off = node_addr - ptr_value;

                        // Build the new suffix: prepend struct_off
                        let mut new_suffix = Vec::with_capacity(suffix.len() + 1);
                        new_suffix.push(struct_off);
                        new_suffix.extend_from_slice(suffix);

                        if let Some(mod_rel) = resolve_module_rel(ptr_addr, modules) {
                            // Only use the main game exe as static anchor
                            // (other modules don't map to game_base offset chains)
                            if mod_rel.starts_with(PROCESS_NAME) {
                                if let Some(plus_pos) = mod_rel.find("+0x") {
                                    let mod_off_str = mod_rel[plus_pos + 3..].to_string();
                                    let mut offsets = Vec::with_capacity(new_suffix.len() + 1);
                                    offsets.push(mod_off_str);
                                    for o in &new_suffix {
                                        offsets.push(format!("{o:X}"));
                                    }
                                    // Deduplicate by offset string
                                    let key = offsets.join(" ");
                                    if !results[ti]
                                        .chains
                                        .iter()
                                        .any(|c| c.offsets.join(" ") == key)
                                    {
                                        results[ti].chains.push(FoundChain {
                                            offsets,
                                            module_rel: mod_rel,
                                            depth: new_suffix.len(),
                                        });
                                    }
                                }
                            }
                        } else if next_queue.len() < max_heap_per_level && !seen.contains(&ptr_addr)
                        {
                            seen.insert(ptr_addr);
                            next_queue.push((ptr_addr, new_suffix));
                        }

                        // Cap total hits per level sweep to avoid unbounded work
                        if next_queue.len() >= max_heap_per_level {
                            break 'nodes;
                        }
                    }
                }

                queue = next_queue;
            }
        }

        results
    }

    /// Full pipeline: open the game process, build the pointer index, run BFS for all
    /// targets, close the process handle, and return results.
    pub fn auto_chain_find_all<F>(
        target_addrs: Vec<String>,
        target_labels: Vec<String>,
        max_depth: usize,
        max_back: u64,
        max_heap_per_level: usize,
        cancel: &AtomicBool,
        progress_cb: F,
    ) -> Result<Vec<AutoChainResult>, String>
    where
        F: Fn(super::AutoChainProgress),
    {
        let pid = find_game_pid().ok_or("Game not running")?;
        let (handle, _base) = open_game(pid).ok_or("Failed to open process")?;
        let modules = list_modules(handle);

        // Phase 0: build pointer index (progress mapped to 0-50%)
        let index = {
            let pb = &progress_cb;
            PtrIndex::build(handle, cancel, |_mb: u32, raw_pct: u8| {
                pb(super::AutoChainProgress {
                    phase: 0,
                    pct: raw_pct / 2,
                    index_size: 0,
                    chains_found: 0,
                    done: false,
                    error: None,
                });
            })?
        };

        let index_size = index.len();
        progress_cb(super::AutoChainProgress {
            phase: 1,
            pct: 50,
            index_size,
            chains_found: 0,
            done: false,
            error: None,
        });

        // Parse targets
        let targets: Vec<(u64, String)> = target_addrs
            .iter()
            .zip(target_labels.iter())
            .filter_map(|(addr, label)| parse_hex(addr).ok().map(|a| (a, label.clone())))
            .collect();

        // Phase 1: BFS search
        let results = find_chains_bfs(
            &targets,
            max_depth,
            max_back,
            max_heap_per_level,
            &modules,
            &index,
            cancel,
        );

        let total_chains: usize = results.iter().map(|r| r.chains.len()).sum();
        progress_cb(super::AutoChainProgress {
            phase: 1,
            pct: 95,
            index_size,
            chains_found: total_chains,
            done: false,
            error: None,
        });

        unsafe {
            let _ = CloseHandle(handle);
        }
        Ok(results)
    }

    pub fn follow_chain(
        offsets_hex: Vec<String>,
        value_type: String,
    ) -> Result<ChainResult, String> {
        let pid = find_game_pid().ok_or("Game not running")?;
        let (handle, game_base) = open_game(pid).ok_or("Failed to open process")?;

        let parsed: Vec<u64> = offsets_hex
            .iter()
            .map(|s| parse_hex(s))
            .collect::<Result<Vec<_>, _>>()?;

        if parsed.is_empty() {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Ok(ChainResult {
                steps: vec![],
                final_addr: None,
                final_value: None,
                ok: false,
                error: Some("Empty chain".into()),
            });
        }

        let n = parsed.len();
        let mut ptr = game_base;
        let mut steps = Vec::new();

        // Dereference all but the last offset, recording each step
        for (i, &off) in parsed[..n - 1].iter().enumerate() {
            let addr = ptr + off;
            let label = if i == 0 {
                format!("game+0x{off:X}")
            } else {
                format!("+0x{off:X}")
            };
            match read_qword(handle, addr) {
                Some(next) => {
                    steps.push(ChainStep {
                        label,
                        addr: format!("0x{addr:X}"),
                        ptr_value: format!("0x{next:X}"),
                        ok: true,
                    });
                    if next == 0 {
                        steps.last_mut().unwrap().ok = false;
                        unsafe {
                            let _ = CloseHandle(handle);
                        }
                        return Ok(ChainResult {
                            steps,
                            final_addr: None,
                            final_value: None,
                            ok: false,
                            error: Some(format!("Null pointer at step {i}")),
                        });
                    }
                    ptr = next;
                }
                None => {
                    steps.push(ChainStep {
                        label,
                        addr: format!("0x{addr:X}"),
                        ptr_value: "??".into(),
                        ok: false,
                    });
                    unsafe {
                        let _ = CloseHandle(handle);
                    }
                    return Ok(ChainResult {
                        steps,
                        final_addr: None,
                        final_value: None,
                        ok: false,
                        error: Some(format!("Read failed at step {i}")),
                    });
                }
            }
        }

        // Final step: add last offset, read as value_type
        let last_off = parsed[n - 1];
        let final_addr = ptr + last_off;
        let size = type_size(&value_type);
        let final_value = read_raw(handle, final_addr, size).map(|b| decode(&b, &value_type));

        steps.push(ChainStep {
            label: format!("+0x{last_off:X}  [{value_type}]"),
            addr: format!("0x{final_addr:X}"),
            ptr_value: final_value
                .map(|v| format!("{v}"))
                .unwrap_or_else(|| "??".into()),
            ok: final_value.is_some(),
        });

        unsafe {
            let _ = CloseHandle(handle);
        }
        Ok(ChainResult {
            steps,
            final_addr: Some(format!("0x{final_addr:X}")),
            final_value,
            ok: final_value.is_some(),
            error: None,
        })
    }

    pub fn get_modules() -> Result<Vec<ModuleEntry>, String> {
        let pid = find_game_pid().ok_or("Game not running")?;
        let (handle, _base) = open_game(pid).ok_or("Failed to open process")?;
        let modules = list_modules(handle);
        unsafe {
            let _ = CloseHandle(handle);
        }
        Ok(modules)
    }

    // ─── Struct region scanner ────────────────────────────────────────────────

    #[derive(serde::Serialize, Clone, Debug)]
    pub struct StructScanHit {
        /// Hex offset from the supplied base address.
        pub offset: String,
        /// Absolute address in the game process.
        pub addr: String,
        /// Decoded value at this position.
        pub value: f64,
    }

    /// Read `radius` bytes from `base_addr` and scan every byte position for
    /// `value_type`-sized data matching `target`.  Byte-by-byte stride is fine
    /// because the radius is small (typically ≤ 16 KB).
    pub fn scan_struct_region(
        base_addr: u64,
        radius: u32,
        value_type: String,
        target: f64,
    ) -> Result<Vec<StructScanHit>, String> {
        let pid = find_game_pid().ok_or("Game not running")?;
        let (handle, _base) = open_game(pid).ok_or("Failed to open process")?;

        let size = type_size(&value_type);
        let radius = radius as usize;
        let target_bytes = encode(target, &value_type);

        let buf = read_raw(handle, base_addr, radius)
            .ok_or_else(|| format!("Failed to read 0x{base_addr:X} +0x{radius:X}"))?;

        unsafe {
            let _ = CloseHandle(handle);
        }

        let mut hits = Vec::new();
        let mut off = 0usize;
        while off + size <= buf.len() {
            let slice = &buf[off..off + size];
            if value_matches(slice, &value_type, &target_bytes, target) {
                hits.push(StructScanHit {
                    offset: format!("0x{off:X}"),
                    addr: format!("0x{:X}", base_addr + off as u64),
                    value: decode(slice, &value_type),
                });
            }
            off += 1;
        }
        Ok(hits)
    }
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

use tauri::Emitter;

/// Batch-read watch entries.  Each entry is either a raw address or a pointer chain.
/// Opens the game process once, reads all values, closes.  Called at ~1 Hz by the UI.
#[tauri::command]
pub async fn mem_read_watches(requests: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    tokio::task::spawn_blocking(move || {
        #[cfg(all(target_os = "windows", feature = "ocr"))]
        {
            let typed: Vec<imp::WatchRequest> = requests
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect();
            imp::read_watches(typed)
                .into_iter()
                .map(|r| serde_json::to_value(r).unwrap_or(serde_json::Value::Null))
                .collect()
        }
        #[cfg(not(all(target_os = "windows", feature = "ocr")))]
        requests
            .iter()
            .map(|_| serde_json::json!({ "ok": false, "error": "not available on this platform" }))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Scan all committed read-write memory pages for a value.
///
/// - Runs on the blocking thread pool (never touches the main/UI thread).
/// - Emits `mem-scan-progress` events as data is read so the UI stays live.
/// - Emits a final `mem-scan-progress` with `done: true` on completion/cancel/error.
/// - Wrapped in `catch_unwind` so a panic cannot crash the app.
/// - Cancel with `mem_scan_cancel`.
#[tauri::command]
pub async fn mem_scan(
    app: tauri::AppHandle,
    value_type: String,
    target: f64,
) -> Result<Vec<serde_json::Value>, String> {
    SCAN_CANCEL.store(false, Ordering::Relaxed);
    log::info!("mem_scan: start — value={target} type={value_type}");

    let app2 = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            #[cfg(all(target_os = "windows", feature = "ocr"))]
            {
                let app_cb = app.clone();
                let cb = move |scanned_mb: u32, pct: u8, hits: usize| {
                    log::debug!("mem_scan: {scanned_mb} MB, {hits} hits, ~{pct}%");
                    let _ = app_cb.emit(
                        EVENT_SCAN_PROGRESS,
                        ScanProgress {
                            scanned_mb,
                            hits,
                            pct,
                            done: false,
                            cancelled: false,
                            error: None,
                        },
                    );
                };
                imp::scan(value_type, target, &SCAN_CANCEL, cb).map(|hits| {
                    hits.into_iter()
                        .map(|h| serde_json::to_value(h).unwrap())
                        .collect::<Vec<_>>()
                })
            }
            #[cfg(not(all(target_os = "windows", feature = "ocr")))]
            Err::<Vec<serde_json::Value>, String>("not available on this platform".into())
        }))
        .unwrap_or_else(|_| {
            log::error!("mem_scan: panicked — game process may have changed state");
            Err("Scan panicked — game process may have changed state".into())
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let cancelled = SCAN_CANCEL.load(Ordering::Relaxed);
    let (hits_count, err) = match &result {
        Ok(v) => (v.len(), None),
        Err(e) => (0, Some(e.clone())),
    };
    log::info!(
        "mem_scan: done — {} hits, cancelled={cancelled}",
        hits_count
    );
    let _ = app2.emit(
        EVENT_SCAN_PROGRESS,
        ScanProgress {
            scanned_mb: 0,
            hits: hits_count,
            pct: 100,
            done: true,
            cancelled,
            error: err,
        },
    );
    result
}

/// Cancel a running `mem_scan`.  Safe to call even when no scan is running.
#[tauri::command]
pub fn mem_scan_cancel() {
    SCAN_CANCEL.store(true, Ordering::Relaxed);
    log::info!("mem_scan: cancel requested");
}

/// Re-check a previous scan's addresses with a new (or same) target value.
#[tauri::command]
pub async fn mem_rescan(
    addrs: Vec<String>,
    value_type: String,
    target: f64,
) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(all(target_os = "windows", feature = "ocr"))]
        return imp::rescan(addrs, value_type, target).map(|hits| {
            hits.into_iter()
                .map(|h| serde_json::to_value(h).unwrap())
                .collect()
        });
        #[cfg(not(all(target_os = "windows", feature = "ocr")))]
        Err("not available on this platform".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Follow a pointer chain from the game module base.
/// offsets_hex: all offsets as hex strings (e.g. ["4F5FBF0", "0", "9C8"]).
/// All but the last are qword-dereferenced; the last is added to get the final address.
#[tauri::command]
pub async fn mem_follow_chain(
    offsets_hex: Vec<String>,
    value_type: String,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(all(target_os = "windows", feature = "ocr"))]
        return imp::follow_chain(offsets_hex, value_type)
            .map(|r| serde_json::to_value(r).unwrap());
        #[cfg(not(all(target_os = "windows", feature = "ocr")))]
        Err("not available on this platform".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Scan memory for 8-byte pointers in [target_addr - max_back, target_addr].
/// Module-relative hits are stable across restarts — ideal as chain base offsets.
/// Uses the same SCAN_CANCEL token as mem_scan; emits "mem-ptr-scan-progress" events.
#[tauri::command]
pub async fn mem_ptr_scan(
    app: tauri::AppHandle,
    target_addr: String,
    max_back: u64,
) -> Result<Vec<serde_json::Value>, String> {
    SCAN_CANCEL.store(false, Ordering::Relaxed);
    log::info!("mem_ptr_scan: start — target={target_addr} max_back=0x{max_back:X}");

    let app2 = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            #[cfg(all(target_os = "windows", feature = "ocr"))]
            {
                let target = match imp::parse_hex(&target_addr) {
                    Ok(v) => v,
                    Err(e) => return Err(format!("Bad target addr: {e}")),
                };
                let app_cb = app.clone();
                let cb = move |scanned_mb: u32, pct: u8, hits: usize| {
                    let _ = app_cb.emit(
                        EVENT_PTR_SCAN_PROGRESS,
                        ScanProgress {
                            scanned_mb,
                            hits,
                            pct,
                            done: false,
                            cancelled: false,
                            error: None,
                        },
                    );
                };
                imp::ptr_scan(target, max_back, &SCAN_CANCEL, cb).map(|hits| {
                    hits.into_iter()
                        .map(|h| serde_json::to_value(h).unwrap())
                        .collect::<Vec<_>>()
                })
            }
            #[cfg(not(all(target_os = "windows", feature = "ocr")))]
            Err::<Vec<serde_json::Value>, String>("not available on this platform".into())
        }))
        .unwrap_or_else(|_| {
            log::error!("mem_ptr_scan: panicked");
            Err("Ptr scan panicked".into())
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let cancelled = SCAN_CANCEL.load(Ordering::Relaxed);
    let (hits_count, err) = match &result {
        Ok(v) => (v.len(), None),
        Err(e) => (0, Some(e.clone())),
    };
    log::info!("mem_ptr_scan: done — {hits_count} hits, cancelled={cancelled}");
    let _ = app2.emit(
        EVENT_PTR_SCAN_PROGRESS,
        ScanProgress {
            scanned_mb: 0,
            hits: hits_count,
            pct: 100,
            done: true,
            cancelled,
            error: err,
        },
    );
    result
}

/// Build a full pointer index from all committed memory pages, then run multi-level
/// BFS to find static pointer chains that lead to each target address.
///
/// - `target_addrs`     : hex addresses of the values we want chains for.
/// - `target_labels`    : human-readable labels (one per address, shown in results).
/// - `max_depth`        : BFS levels (pointer dereferences).  5 is a good default.
/// - `max_back`         : how far before the target a pointer may point (e.g. 0x1000).
/// - `max_heap_per_level`: cap on heap addresses queued per BFS level to bound runtime.
///
/// Emits `mem-auto-chain-progress` events.  Cancelled via `mem_scan_cancel`.
#[tauri::command]
pub async fn mem_auto_chain_find(
    app: tauri::AppHandle,
    target_addrs: Vec<String>,
    target_labels: Vec<String>,
    max_depth: usize,
    max_back: u64,
    max_heap_per_level: usize,
) -> Result<Vec<serde_json::Value>, String> {
    SCAN_CANCEL.store(false, Ordering::Relaxed);
    log::info!(
        "mem_auto_chain_find: {} targets, depth={max_depth}, back=0x{max_back:X}",
        target_addrs.len()
    );

    let app2 = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            #[cfg(all(target_os = "windows", feature = "ocr"))]
            {
                let app_cb = app.clone();
                imp::auto_chain_find_all(
                    target_addrs,
                    target_labels,
                    max_depth,
                    max_back,
                    max_heap_per_level,
                    &SCAN_CANCEL,
                    move |p: AutoChainProgress| {
                        let _ = app_cb.emit(EVENT_AUTO_CHAIN_PROGRESS, p);
                    },
                )
                .map(|results| {
                    results
                        .into_iter()
                        .map(|r| serde_json::to_value(r).unwrap())
                        .collect::<Vec<_>>()
                })
            }
            #[cfg(not(all(target_os = "windows", feature = "ocr")))]
            Err::<Vec<serde_json::Value>, String>("not available on this platform".into())
        }))
        .unwrap_or_else(|_| {
            log::error!("mem_auto_chain_find: panicked");
            Err("Auto chain find panicked — game process may have changed state".into())
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let cancelled = SCAN_CANCEL.load(Ordering::Relaxed);
    let (chains_found, err) = match &result {
        Ok(v) => (v.len(), None),
        Err(e) => (0, Some(e.clone())),
    };
    log::info!("mem_auto_chain_find: done — {chains_found} target results, cancelled={cancelled}");
    let _ = app2.emit(
        EVENT_AUTO_CHAIN_PROGRESS,
        AutoChainProgress {
            phase: 1,
            pct: 100,
            index_size: 0,
            chains_found,
            done: true,
            error: err,
        },
    );
    result
}

/// Scan a fixed memory region [base_addr_hex, base_addr_hex + radius) for a target value.
///
/// Intended use: you have a known object base (e.g. from the last pointer dereference in a
/// chain) and want to discover which offsets inside that struct hold other stat values.
///
/// - `base_addr_hex` — hex address of the object/struct base (e.g. "0x18B3A4000")
/// - `value_type`    — data type to interpret candidates as ("i32", "f32", etc.)
/// - `target`        — the value to search for (current live value of the desired stat)
/// - `radius`        — how many bytes to scan (e.g. 4096)
#[tauri::command]
pub async fn mem_scan_struct(
    base_addr_hex: String,
    value_type: String,
    target: f64,
    radius: u32,
) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(all(target_os = "windows", feature = "ocr"))]
        {
            let base_addr =
                imp::parse_hex(&base_addr_hex).map_err(|e| format!("Bad base addr: {e}"))?;
            imp::scan_struct_region(base_addr, radius, value_type, target).map(|hits| {
                hits.into_iter()
                    .map(|h| serde_json::to_value(h).unwrap())
                    .collect()
            })
        }
        #[cfg(not(all(target_os = "windows", feature = "ocr")))]
        Err("not available on this platform".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List all modules loaded in the game process with base address and size.
#[tauri::command]
pub async fn mem_get_modules() -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(|| {
        #[cfg(all(target_os = "windows", feature = "ocr"))]
        return imp::get_modules().map(|mods| {
            mods.into_iter()
                .map(|m| serde_json::to_value(m).unwrap())
                .collect()
        });
        #[cfg(not(all(target_os = "windows", feature = "ocr")))]
        Err("not available on this platform".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
