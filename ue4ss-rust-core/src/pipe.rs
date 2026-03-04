use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::{ffi::c_void, ptr};

static CONNECTED: AtomicBool = AtomicBool::new(false);
static PIPE_HANDLE: AtomicUsize = AtomicUsize::new(0);
static LAST_ERROR: AtomicU32 = AtomicU32::new(0);

const PIPE_NAME: &[u8] = b"\\\\.\\pipe\\kovaaks-bridge\0";
const GENERIC_WRITE: u32 = 0x4000_0000;
const FILE_SHARE_NONE: u32 = 0x0000_0000;
const OPEN_EXISTING: u32 = 3;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;

type Handle = *mut c_void;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

#[link(name = "kernel32")]
extern "system" {
    fn CreateFileA(
        lp_file_name: *const u8,
        dw_desired_access: u32,
        dw_share_mode: u32,
        lp_security_attributes: *mut c_void,
        dw_creation_disposition: u32,
        dw_flags_and_attributes: u32,
        h_template_file: Handle,
    ) -> Handle;
    fn WriteFile(
        h_file: Handle,
        lp_buffer: *const c_void,
        n_number_of_bytes_to_write: u32,
        lp_number_of_bytes_written: *mut u32,
        lp_overlapped: *mut c_void,
    ) -> i32;
    fn CloseHandle(h_object: Handle) -> i32;
    fn GetLastError() -> u32;
}

pub fn connect() -> Result<(), String> {
    if is_connected() {
        return Ok(());
    }

    let handle = unsafe {
        CreateFileA(
            PIPE_NAME.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_NONE,
            ptr::null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
        PIPE_HANDLE.store(handle as usize, Ordering::Release);
        CONNECTED.store(true, Ordering::Release);
        LAST_ERROR.store(0, Ordering::Release);
        return Ok(());
    }

    let err = unsafe { GetLastError() };
    LAST_ERROR.store(err, Ordering::Release);
    Err(format!("CreateFile(\\\\.\\pipe\\kovaaks-bridge) failed with {}", err))
}

pub fn write_event(json: &str) -> bool {
    if !CONNECTED.load(Ordering::Acquire) {
        return false;
    }

    let handle = PIPE_HANDLE.load(Ordering::Acquire) as Handle;
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        CONNECTED.store(false, Ordering::Release);
        LAST_ERROR.store(6, Ordering::Release); // ERROR_INVALID_HANDLE
        return false;
    }

    let mut line = String::with_capacity(json.len() + 1);
    line.push_str(json);
    line.push('\n');

    let mut written = 0u32;
    let bytes = line.as_bytes();
    let ok = unsafe {
        WriteFile(
            handle,
            bytes.as_ptr() as *const c_void,
            bytes.len() as u32,
            &mut written,
            ptr::null_mut(),
        )
    };

    if ok == 0 || written as usize != bytes.len() {
        let err = unsafe { GetLastError() };
        CONNECTED.store(false, Ordering::Release);
        LAST_ERROR.store(err, Ordering::Release);
        unsafe {
            let _ = CloseHandle(handle);
        }
        return false;
    }

    true
}

pub fn is_connected() -> bool {
    CONNECTED.load(Ordering::Acquire)
}

pub fn close() {
    if !CONNECTED.swap(false, Ordering::AcqRel) {
        return;
    }

    let raw = PIPE_HANDLE.swap(0, Ordering::AcqRel) as Handle;
    if !raw.is_null() && raw != INVALID_HANDLE_VALUE {
        unsafe {
            let _ = CloseHandle(raw);
        }
    }
}

pub fn last_error() -> u32 {
    LAST_ERROR.load(Ordering::Acquire)
}
