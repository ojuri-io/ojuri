import CircuitBreaker from "opossum";
import logger from "@shared/utils/logger";
import { metricsService } from "@shared/metrics/metrics.service";

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

/**
 * Circuit breaker configuration options
 */
export interface CircuitBreakerOptions {
  name: string;
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
  volumeThreshold?: number;
  fallback?: (...args: any[]) => any;
}

/**
 * Creates a circuit breaker wrapper for any async function
 * @param fn - The async function to wrap
 * @param options - Circuit breaker configuration
 * @returns Wrapped function with circuit breaker protection
 */
export function createCircuitBreaker<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: CircuitBreakerOptions
): CircuitBreaker<any[], any> {
  const breaker = new CircuitBreaker(fn, {
    timeout: options.timeout,
    errorThresholdPercentage: options.errorThresholdPercentage,
    resetTimeout: options.resetTimeout,
    volumeThreshold: options.volumeThreshold || 5,
    name: options.name,
  });

  // Set fallback if provided
  if (options.fallback) {
    breaker.fallback(options.fallback);
  }

  // Event listeners for monitoring
  breaker.on("success", () => {
    metricsService.recordCircuitBreakerState(options.name, CircuitState.CLOSED);
  });

  breaker.on("timeout", () => {
    logger.warn({ circuitBreaker: options.name }, "Circuit breaker timeout");
    metricsService.incrementCircuitBreakerEvent(options.name, "timeout");
  });

  breaker.on("reject", () => {
    logger.warn({ circuitBreaker: options.name }, "Circuit breaker rejected request");
    metricsService.incrementCircuitBreakerEvent(options.name, "reject");
  });

  breaker.on("open", () => {
    logger.error({ circuitBreaker: options.name }, "Circuit breaker opened - failing fast");
    metricsService.recordCircuitBreakerState(options.name, CircuitState.OPEN);
  });

  breaker.on("halfOpen", () => {
    logger.info({ circuitBreaker: options.name }, "Circuit breaker half-open - attempting recovery");
    metricsService.recordCircuitBreakerState(options.name, CircuitState.HALF_OPEN);
  });

  breaker.on("close", () => {
    logger.info({ circuitBreaker: options.name }, "Circuit breaker closed - recovered");
    metricsService.recordCircuitBreakerState(options.name, CircuitState.CLOSED);
  });

  breaker.on("fallback", () => {
    logger.warn({ circuitBreaker: options.name }, "Circuit breaker using fallback");
    metricsService.incrementCircuitBreakerEvent(options.name, "fallback");
  });

  return breaker;
}

/**
 * Get the current state of a circuit breaker
 */
export function getCircuitState(breaker: CircuitBreaker<any, any>): CircuitState {
  if (breaker.opened) return CircuitState.OPEN;
  if (breaker.halfOpen) return CircuitState.HALF_OPEN;
  return CircuitState.CLOSED;
}
