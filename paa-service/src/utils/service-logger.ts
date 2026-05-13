import pino from "pino";
import appConfig from "@config/app.config";
import { AsyncLocalStorage } from "async_hooks";

/**
 * Trace context type for correlation across async operations
 * Includes traceId, senderId, and transactionId for comprehensive request tracing
 */
export interface TraceContextData {
  traceId: string;
  senderId?: string;
  transactionId?: string;
  [key: string]: unknown;
}

/**
 * AsyncLocalStorage for trace context propagation
 */
const traceStorage = new AsyncLocalStorage<TraceContextData>();

/**
 * TraceContext helper for managing trace context
 */
export const TraceContext = {
  /**
   * Run a function with trace context
   */
  runAsync<T>(context: TraceContextData, fn: () => Promise<T>): Promise<T> {
    return traceStorage.run(context, fn);
  },

  /**
   * Run a sync function with trace context
   */
  run<T>(context: TraceContextData, fn: () => T): T {
    return traceStorage.run(context, fn);
  },

  /**
   * Get current trace context
   */
  get(): TraceContextData | undefined {
    return traceStorage.getStore();
  },

  /**
   * Get trace ID from context
   */
  getTraceId(): string | undefined {
    return traceStorage.getStore()?.traceId;
  },

  /**
   * Get sender ID from context
   */
  getSenderId(): string | undefined {
    return traceStorage.getStore()?.senderId;
  },

  /**
   * Get transaction ID from context
   */
  getTransactionId(): string | undefined {
    return traceStorage.getStore()?.transactionId;
  },
};

/**
 * Base pino logger instance
 */
const baseLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  enabled: appConfig.app.env !== "test",
  mixin() {
    return {
      service: appConfig.app.name,
    };
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Format log message in structured format
 * Format: ClassName[methodName]: Level. description
 */
function formatMessage(className: string, method: string, level: string, description?: string): string {
  const desc = description ? `. ${description}` : "";
  return `${className}[${method}]: ${level}${desc}`;
}

/**
 * Merge trace context with payload
 */
function mergeContext(payload?: Record<string, unknown>): Record<string, unknown> {
  const context = TraceContext.get();
  return {
    ...(context || {}),
    ...(payload || {}),
  };
}

/**
 * Service logger type
 */
export interface ServiceLogger {
  entry(method: string, description: string, payload?: Record<string, unknown>): void;
  exit(method: string, description?: string, payload?: Record<string, unknown>): void;
  success(method: string, description: string, payload?: Record<string, unknown>): void;
  failure(method: string, description: string, payload?: Record<string, unknown>): void;
  error(method: string, description: string, payload?: Record<string, unknown>): void;
  info(method: string, description: string, payload?: Record<string, unknown>): void;
  debug(method: string, description: string, payload?: Record<string, unknown>): void;
  warn(method: string, description: string, payload?: Record<string, unknown>): void;
}

/**
 * Create a service logger for a specific class/service
 * @param className - The name of the class/service
 * @returns ServiceLogger instance
 */
export function createServiceLogger(className: string): ServiceLogger {
  return {
    entry(method: string, description: string, payload?: Record<string, unknown>): void {
      baseLogger.info(mergeContext(payload), formatMessage(className, method, "Entry", description));
    },

    exit(method: string, description?: string, payload?: Record<string, unknown>): void {
      baseLogger.info(mergeContext(payload), formatMessage(className, method, "Exit", description));
    },

    success(method: string, description: string, payload?: Record<string, unknown>): void {
      baseLogger.info(mergeContext(payload), formatMessage(className, method, "Success", description));
    },

    failure(method: string, description: string, payload?: Record<string, unknown>): void {
      baseLogger.warn(mergeContext(payload), formatMessage(className, method, "Failure", description));
    },

    error(method: string, description: string, payload?: Record<string, unknown>): void {
      baseLogger.error(mergeContext(payload), formatMessage(className, method, "Error", description));
    },

    info(method: string, description: string, payload?: Record<string, unknown>): void {
      baseLogger.info(mergeContext(payload), formatMessage(className, method, "Info", description));
    },

    debug(method: string, description: string, payload?: Record<string, unknown>): void {
      baseLogger.debug(mergeContext(payload), formatMessage(className, method, "Debug", description));
    },

    warn(method: string, description: string, payload?: Record<string, unknown>): void {
      baseLogger.warn(mergeContext(payload), formatMessage(className, method, "Warn", description));
    },
  };
}

export default createServiceLogger;
