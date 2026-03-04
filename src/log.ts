// Simple log helper for frontend -> tauri log buffer
import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

export function log(level: LogLevel, target: string, message: string) {
  // Fire and forget; don't await
  invoke("frontend_log", { level, target, message }).catch(() => {});
}

export function logError(target: string, message: string) {
  log("ERROR", target, message);
}
export function logWarn(target: string, message: string) {
  log("WARN", target, message);
}
export function logInfo(target: string, message: string) {
  log("INFO", target, message);
}
export function logDebug(target: string, message: string) {
  log("DEBUG", target, message);
}
