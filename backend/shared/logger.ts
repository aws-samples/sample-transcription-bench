/**
 * Structured JSON logger for CloudWatch.
 *
 * Outputs one JSON line per log call to stdout/stderr, which CloudWatch
 * captures automatically. Each entry includes `level`, `timestamp`, and
 * any additional context fields passed in.
 */

export type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, fields: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info(fields: Record<string, unknown>): void {
    emit('info', fields);
  },
  warn(fields: Record<string, unknown>): void {
    emit('warn', fields);
  },
  error(fields: Record<string, unknown>): void {
    emit('error', fields);
  },
};
