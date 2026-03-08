use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::{ffi::c_void, ptr};

static CONNECTED: AtomicBool = AtomicBool::new(false);
static PIPE_HANDLE: AtomicUsize = AtomicUsize::new(0);
static LAST_ERROR: AtomicU32 = AtomicU32::new(0);

static COMMAND_CONNECTED: AtomicBool = AtomicBool::new(false);
static COMMAND_HANDLE: AtomicUsize = AtomicUsize::new(0);
static COMMAND_LAST_ERROR: AtomicU32 = AtomicU32::new(0);

const EVENT_PIPE_NAME: &[u8] = b"\\\\.\\pipe\\kovaaks-bridge\0";
const COMMAND_PIPE_NAME: &[u8] = b"\\\\.\\pipe\\kovaaks-bridge-cmd\0";
const GENERIC_WRITE: u32 = 0x4000_0000;
const GENERIC_READ: u32 = 0x8000_0000;
const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
const FILE_WRITE_ATTRIBUTES: u32 = 0x0000_0100;
const FILE_SHARE_NONE: u32 = 0x0000_0000;
const OPEN_EXISTING: u32 = 3;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
const ERROR_ACCESS_DENIED: u32 = 5;

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
    fn ReadFile(
        h_file: Handle,
        lp_buffer: *mut c_void,
        n_number_of_bytes_to_read: u32,
        lp_number_of_bytes_read: *mut u32,
        lp_overlapped: *mut c_void,
    ) -> i32;
    fn PeekNamedPipe(
        h_named_pipe: Handle,
        lp_buffer: *mut c_void,
        n_buffer_size: u32,
        lp_bytes_read: *mut u32,
        lp_total_bytes_avail: *mut u32,
        lp_bytes_left_this_message: *mut u32,
    ) -> i32;
    fn GetNamedPipeInfo(
        h_named_pipe: Handle,
        lp_flags: *mut u32,
        lp_out_buffer_size: *mut u32,
        lp_in_buffer_size: *mut u32,
        lp_max_instances: *mut u32,
    ) -> i32;
    fn WaitNamedPipeA(lp_named_pipe_name: *const u8, n_time_out: u32) -> i32;
    fn CloseHandle(h_object: Handle) -> i32;
    fn GetLastError() -> u32;
}

fn command_buffer() -> &'static Mutex<Vec<u8>> {
    static BUFFER: OnceLock<Mutex<Vec<u8>>> = OnceLock::new();
    BUFFER.get_or_init(|| Mutex::new(Vec::with_capacity(4096)))
}

fn wait_named_pipe_now(name: *const u8) -> Result<(), u32> {
    let ok = unsafe { WaitNamedPipeA(name, 0) };
    if ok != 0 {
        return Ok(());
    }
    Err(unsafe { GetLastError() })
}

fn named_pipe_handle_alive(handle: Handle) -> Result<(), u32> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(6); // ERROR_INVALID_HANDLE
    }

    let ok = unsafe {
        GetNamedPipeInfo(
            handle,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if ok != 0 {
        return Ok(());
    }

    Err(unsafe { GetLastError() })
}

fn is_nonfatal_pipe_probe_error(err: u32) -> bool {
    err == ERROR_ACCESS_DENIED
}

fn close_event_pipe() {
    CONNECTED.store(false, Ordering::Release);
    let raw = PIPE_HANDLE.swap(0, Ordering::AcqRel) as Handle;
    if !raw.is_null() && raw != INVALID_HANDLE_VALUE {
        unsafe {
            let _ = CloseHandle(raw);
        }
    }
}

pub fn connect_event() -> Result<(), String> {
    if is_event_connected() {
        return Ok(());
    }

    if let Err(err) = wait_named_pipe_now(EVENT_PIPE_NAME.as_ptr()) {
        LAST_ERROR.store(err, Ordering::Release);
        return Err(format!(
            "WaitNamedPipe(\\\\.\\pipe\\kovaaks-bridge) failed with {}",
            err
        ));
    }

    let handle = unsafe {
        CreateFileA(
            EVENT_PIPE_NAME.as_ptr(),
            GENERIC_WRITE | FILE_READ_ATTRIBUTES,
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

fn connect_command() -> Result<(), String> {
    if is_command_connected() {
        return Ok(());
    }

    if let Err(err) = wait_named_pipe_now(COMMAND_PIPE_NAME.as_ptr()) {
        COMMAND_LAST_ERROR.store(err, Ordering::Release);
        return Err(format!(
            "WaitNamedPipe(\\\\.\\pipe\\kovaaks-bridge-cmd) failed with {}",
            err
        ));
    }

    let handle = unsafe {
        CreateFileA(
            COMMAND_PIPE_NAME.as_ptr(),
            GENERIC_READ | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES,
            FILE_SHARE_NONE,
            ptr::null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
        COMMAND_HANDLE.store(handle as usize, Ordering::Release);
        COMMAND_CONNECTED.store(true, Ordering::Release);
        COMMAND_LAST_ERROR.store(0, Ordering::Release);
        return Ok(());
    }

    let err = unsafe { GetLastError() };
    COMMAND_LAST_ERROR.store(err, Ordering::Release);
    Err(format!(
        "CreateFile(\\\\.\\pipe\\kovaaks-bridge-cmd) failed with {}",
        err
    ))
}

pub fn connect() -> Result<(), String> {
    connect_event()?;
    connect_command()?;
    Ok(())
}

pub fn write_event(json: &str) -> bool {
    if !CONNECTED.load(Ordering::Acquire) {
        return false;
    }

    let handle = PIPE_HANDLE.load(Ordering::Acquire) as Handle;
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        LAST_ERROR.store(6, Ordering::Release); // ERROR_INVALID_HANDLE
        close_event_pipe();
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
        LAST_ERROR.store(err, Ordering::Release);
        close_event_pipe();
        return false;
    }

    true
}

fn close_command_pipe() {
    if !COMMAND_CONNECTED.swap(false, Ordering::AcqRel) {
        return;
    }

    let raw = COMMAND_HANDLE.swap(0, Ordering::AcqRel) as Handle;
    if !raw.is_null() && raw != INVALID_HANDLE_VALUE {
        unsafe {
            let _ = CloseHandle(raw);
        }
    }

    if let Ok(mut buf) = command_buffer().lock() {
        buf.clear();
    }
}

fn read_available_command_bytes(handle: Handle, out: &mut Vec<u8>) -> bool {
    let mut available = 0u32;
    let ok = unsafe {
        PeekNamedPipe(
            handle,
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &mut available,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        COMMAND_LAST_ERROR.store(err, Ordering::Release);
        close_command_pipe();
        return false;
    }
    if available == 0 {
        return true;
    }

    let mut temp = vec![0u8; available.min(8192) as usize];
    let mut read = 0u32;
    let read_ok = unsafe {
        ReadFile(
            handle,
            temp.as_mut_ptr() as *mut c_void,
            temp.len() as u32,
            &mut read,
            ptr::null_mut(),
        )
    };
    if read_ok == 0 {
        let err = unsafe { GetLastError() };
        COMMAND_LAST_ERROR.store(err, Ordering::Release);
        close_command_pipe();
        return false;
    }

    if read > 0 {
        out.extend_from_slice(&temp[..read as usize]);
    }
    true
}

pub fn poll_command_line(out: &mut [u8]) -> i32 {
    if out.is_empty() {
        return -1;
    }

    if COMMAND_CONNECTED.load(Ordering::Acquire) {
        let handle = COMMAND_HANDLE.load(Ordering::Acquire) as Handle;
        if let Err(err) = named_pipe_handle_alive(handle) {
            if !is_nonfatal_pipe_probe_error(err) {
                COMMAND_LAST_ERROR.store(err, Ordering::Release);
                close_command_pipe();
            }
        }
    }

    if !COMMAND_CONNECTED.load(Ordering::Acquire) && connect_command().is_err() {
        return 0;
    }

    let handle = COMMAND_HANDLE.load(Ordering::Acquire) as Handle;
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        close_command_pipe();
        return 0;
    }

    let Ok(mut buffer) = command_buffer().lock() else {
        return 0;
    };

    if !read_available_command_bytes(handle, &mut buffer) {
        return 0;
    }

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
    if !CONNECTED.load(Ordering::Acquire) {
        return false;
    }

    let handle = PIPE_HANDLE.load(Ordering::Acquire) as Handle;
    if let Err(err) = named_pipe_handle_alive(handle) {
        if !is_nonfatal_pipe_probe_error(err) {
            LAST_ERROR.store(err, Ordering::Release);
            close_event_pipe();
            return false;
        }
    }

    true
}

pub fn is_command_connected() -> bool {
    if !COMMAND_CONNECTED.load(Ordering::Acquire) {
        return false;
    }

    let handle = COMMAND_HANDLE.load(Ordering::Acquire) as Handle;
    if let Err(err) = named_pipe_handle_alive(handle) {
        if !is_nonfatal_pipe_probe_error(err) {
            COMMAND_LAST_ERROR.store(err, Ordering::Release);
            close_command_pipe();
            return false;
        }
    }

    true
}

pub fn is_connected() -> bool {
    is_event_connected() && is_command_connected()
}

pub fn close() {
    close_event_pipe();
    close_command_pipe();
}

pub fn last_error() -> u32 {
    let event_error = LAST_ERROR.load(Ordering::Acquire);
    let command_error = COMMAND_LAST_ERROR.load(Ordering::Acquire);
    if !COMMAND_CONNECTED.load(Ordering::Acquire) && command_error != 0 {
        command_error
    } else {
        event_error
    }
}

#[allow(dead_code)]
pub fn command_last_error() -> u32 {
    COMMAND_LAST_ERROR.load(Ordering::Acquire)
}
