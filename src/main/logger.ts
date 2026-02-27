/**
 * Logger module for Fluent Reader
 * 
 * Uses electron-log to write logs to:
 * - Console (during development)
 * - File at %APPDATA%/fluent-reader/logs/ (always)
 * 
 * Log Levels (from most to least verbose):
 * - silly:   Extremely detailed tracing
 * - debug:   Detailed debugging info (prefetch steps, view operations)
 * - verbose: Important operations (navigation, cache hits)
 * - info:    Startup, major events
 * - warn:    Warnings (stale loading, alignment issues)
 * - error:   Errors only
 * 
 * Log files are automatically rotated when they exceed 10MB.
 */
import log from 'electron-log'
import { app } from 'electron'
import path from 'path'

// Log level type
export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'

// Current log level - can be changed at runtime
let currentFileLevel: LogLevel = 'debug'
let currentConsoleLevel: LogLevel = 'info'

// Configure log file location
// Default: %APPDATA%/fluent-reader/logs/main.log (Windows)
//          ~/Library/Logs/fluent-reader/main.log (macOS)
//          ~/.config/fluent-reader/logs/main.log (Linux)
log.transports.file.resolvePathFn = () => {
    const logsDir = path.join(app.getPath('userData'), 'logs')
    return path.join(logsDir, 'main.log')
}

// File transport settings
log.transports.file.level = currentFileLevel
log.transports.file.maxSize = 10 * 1024 * 1024  // 10MB max file size
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'

// Console transport settings
// In development: show verbose and above
// In production: show only warnings and errors
log.transports.console.level = app.isPackaged ? 'warn' : 'verbose'
log.transports.console.format = '[{h}:{i}:{s}] [{level}] {text}'

// Add source location to log messages (useful for debugging)
log.transports.file.inspectOptions = {
    depth: 3,
    colors: false
}

/**
 * Set the log level for file and/or console output
 * @param level The minimum level to log
 * @param target 'file', 'console', or 'both' (default: 'both')
 */
export function setLogLevel(level: LogLevel, target: 'file' | 'console' | 'both' = 'both'): void {
    if (target === 'file' || target === 'both') {
        currentFileLevel = level
        log.transports.file.level = level
    }
    if (target === 'console' || target === 'both') {
        currentConsoleLevel = level
        log.transports.console.level = level
    }
    log.info(`Log level changed: file=${currentFileLevel}, console=${currentConsoleLevel}`)
}

/**
 * Get current log levels
 */
export function getLogLevels(): { file: LogLevel, console: LogLevel } {
    return { file: currentFileLevel, console: currentConsoleLevel }
}

/**
 * Log a debug message (detailed debugging, view operations)
 */
export function logDebug(message: string, ...args: unknown[]): void {
    log.debug(message, ...args)
}

/**
 * Log a verbose message (important operations like navigation, cache hits)
 */
export function logVerbose(message: string, ...args: unknown[]): void {
    log.verbose(message, ...args)
}

/**
 * Log an info message (startup, major events)
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
 * 
 * Usage:
 *   const log = createScopedLogger('ContentViewPool')
 *   log.verbose('Cache HIT') // → "[ContentViewPool] Cache HIT"
 *   log.debug('View state:', viewData) // → "[ContentViewPool] View state: {...}"
 */
export function createScopedLogger(scope: string) {
    const prefix = `[${scope}]`
    return {
        /** Extremely detailed tracing */
        silly: (message: string, ...args: unknown[]) => log.silly(`${prefix} ${message}`, ...args),
        /** Detailed debugging info (prefetch steps, view operations) */
        debug: (message: string, ...args: unknown[]) => log.debug(`${prefix} ${message}`, ...args),
        /** Important operations (navigation, cache hits) */
        verbose: (message: string, ...args: unknown[]) => log.verbose(`${prefix} ${message}`, ...args),
        /** Startup, major events */
        info: (message: string, ...args: unknown[]) => log.info(`${prefix} ${message}`, ...args),
        /** Warnings (stale loading, alignment issues) */
        warn: (message: string, ...args: unknown[]) => log.warn(`${prefix} ${message}`, ...args),
        /** Errors only */
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
