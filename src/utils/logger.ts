export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  private level: LogLevel;
  private prefix: string;

  constructor(prefix = 'lattice', level: LogLevel = 'info') {
    this.prefix = prefix;
    this.level = level;
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public child(childPrefix: string): Logger {
    return new Logger(`${this.prefix}:${childPrefix}`, this.level);
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS[this.level];
  }

  private format(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta !== undefined ? ` ${typeof meta === 'object' ? JSON.stringify(meta) : String(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${this.prefix}] ${message}${metaStr}`;
  }

  public debug(message: string, meta?: unknown): void {
    if (this.shouldLog('debug')) {
      console.debug(this.format('debug', message, meta));
    }
  }

  public info(message: string, meta?: unknown): void {
    if (this.shouldLog('info')) {
      console.info(this.format('info', message, meta));
    }
  }

  public warn(message: string, meta?: unknown): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format('warn', message, meta));
    }
  }

  public error(message: string, meta?: unknown): void {
    if (this.shouldLog('error')) {
      console.error(this.format('error', message, meta));
    }
  }
}

export const logger = new Logger('gateway');
