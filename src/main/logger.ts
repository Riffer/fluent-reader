/**
 * Logger module for Fluent Reader
 * 
 * Uses electron-log to write logs to:
 * - Console (during development)
 * - File at %APPDATA%/fluent-reader/logs/ (always)
 * 
 * Log files are automatically rotated when they exceed 10MB.
 * Old log files are kept for 30 days.
 */
import log from 'electron-log'
import { app } from 'electron'
import path from 'path'

// Configure log file location
// Default: %APPDATA%/fluent-reader/logs/main.log (Windows)
//          ~/Library/Logs/fluent-reader/main.log (macOS)
//          ~/.config/fluent-reader/logs/main.log (Linux)
log.transports.file.resolvePathFn = () => {
    const logsDir = path.join(app.getPath('userData'), 'logs')
    return path.join(logsDir, 'main.log')
}

// File transport settings
log.transports.file.level = 'debug'
log.transports.file.maxSize = 10 * 1024 * 1024  // 10MB max file size
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'

// Console transport settings
// In development: show all logs
// In production: show only warnings and errors
log.transports.console.level = app.isPackaged ? 'warn' : 'debug'
log.transports.console.format = '[{h}:{i}:{s}] [{level}] {text}'

// Add source location to log messages (useful for debugging)
log.transports.file.inspectOptions = {
    depth: 3,
    colors: false
}

/**
 * Log a debug message (development only in console, always in file)
 */
export function logDebug(message: string, ...args: unknown[]): void {
    log.debug(message, ...args)
}

/**
 * Log an info message
 */
export function logInfo(message: string, ...args: unknown[]): void {
    log.info(message, ...args)
}

/**
 * Log a warning message
 */
export function logWarn(message: string, ...args: unknown[]): void {
    log.warn(message, ...args)
}

/**
 * Log an error message
 */
export function logError(message: string, ...args: unknown[]): void {
    log.error(message, ...args)
}

/**
 * Create a scoped logger with a prefix (e.g., "[ContentViewPool]")
 */
export function createScopedLogger(scope: string) {
    const prefix = `[${scope}]`
    return {
        debug: (message: string, ...args: unknown[]) => log.debug(`${prefix} ${message}`, ...args),
        info: (message: string, ...args: unknown[]) => log.info(`${prefix} ${message}`, ...args),
        warn: (message: string, ...args: unknown[]) => log.warn(`${prefix} ${message}`, ...args),
        error: (message: string, ...args: unknown[]) => log.error(`${prefix} ${message}`, ...args),
    }
}

/**
 * Get the path to the log file
 */
export function getLogFilePath(): string {
    return log.transports.file.getFile()?.path ?? 'unknown'
}

/**
 * Initialize the logger (call once at app startup)
 */
export function initLogger(): void {
    const logPath = getLogFilePath()
    log.info('='.repeat(60))
    log.info(`Fluent Reader starting - Log file: ${logPath}`)
    log.info(`Version: ${app.getVersion()}, Electron: ${process.versions.electron}`)
    log.info(`Platform: ${process.platform}, Arch: ${process.arch}`)
    log.info('='.repeat(60))
}

// Export the raw log object for advanced usage
export { log }
