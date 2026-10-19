/**
 * Dependency-free JSON logger for the indexer.
 * Logs are written as JSON lines to stdout with level, message, timestamp,
 * and optional fields.
 *
 * Extended by issue #1478 to support W3C Trace Context propagation.
 * Incoming HTTP requests should extract the `traceparent` header and pass the
 * resulting context to `withTraceContext` so every log line emitted while
 * handling that request carries the shared `traceId` and `spanId`.
 */

import { randomBytes } from 'crypto';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getCurrentLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LEVEL_PRIORITY) {
    return envLevel as LogLevel;
  }
  return 'info';
}

const currentLevel = getCurrentLogLevel();

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

interface LogFields {
  [key: string]: unknown;
}

// ── W3C Trace Context ────────────────────────────────────────────────────────

const TRACEPARENT_HEADER = 'traceparent';
const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

function generateHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Parses a W3C `traceparent` header value. Returns null when absent or
 * malformed so the caller can generate a fresh root context.
 */
export function parseTraceparent(value: string | null | undefined): TraceContext | null {
  if (!value) return null;
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return null;
  const [, , traceId, spanId, flags] = m;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    sampled: (parseInt(flags, 16) & 0x01) === 1,
  };
}

/** Mints a fresh root trace context (no upstream caller). */
export function newTraceContext(): TraceContext {
  return { traceId: generateHex(16), spanId: generateHex(8), sampled: true };
}

/**
 * Returns the `traceparent` value to forward to downstream services —
 * same traceId, fresh spanId.
 */
export function makeChildTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${generateHex(8)}-${ctx.sampled ? '01' : '00'}`;
}

// ── Logger ───────────────────────────────────────────────────────────────────

// Module-level active trace context; set via withTraceContext() per request.
let activeTrace: TraceContext | null = null;

function log(level: LogLevel, msg: string, fields?: LogFields): void {
  if (!shouldLog(level)) {
    return;
  }

  const logEntry: Record<string, unknown> = {
    level,
    msg,
    ts: new Date().toISOString(),
  };

  // Issue #1478: include traceId/spanId when a trace context is active.
  if (activeTrace) {
    logEntry['traceId'] = activeTrace.traceId;
    logEntry['spanId'] = activeTrace.spanId;
  }

  Object.assign(logEntry, fields ?? {});

  process.stdout.write(JSON.stringify(logEntry) + '\n');
}

export const logger = {
  debug(msg: string, fields?: LogFields): void {
    log('debug', msg, fields);
  },
  info(msg: string, fields?: LogFields): void {
    log('info', msg, fields);
  },
  warn(msg: string, fields?: LogFields): void {
    log('warn', msg, fields);
  },
  error(msg: string, fields?: LogFields): void {
    log('error', msg, fields);
  },
};

/**
 * Sets the active trace context for the current (synchronous) execution
 * scope. Call this at the start of each incoming HTTP request handler,
 * passing the context parsed from the `traceparent` header:
 *
 * ```ts
 * const ctx = parseTraceparent(req.headers[TRACEPARENT_HEADER]) ?? newTraceContext();
 * withTraceContext(ctx, () => {
 *   // all logger calls here will carry ctx.traceId / ctx.spanId
 * });
 * ```
 *
 * NOTE: This sets a module-level variable. For concurrent async requests in
 * a single-process HTTP server, prefer passing the context explicitly as a
 * field in each `logger.*` call instead.
 */
export function withTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  const prev = activeTrace;
  activeTrace = ctx;
  try {
    return fn();
  } finally {
    activeTrace = prev;
  }
}

export { TRACEPARENT_HEADER };
