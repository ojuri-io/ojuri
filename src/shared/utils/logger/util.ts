export function getLogLevelFromStatusCode(statusCode: number) {
  if (statusCode >= 100 && statusCode < 400) return 'info';
  if (statusCode >= 400 && statusCode < 500) return 'warn';

  return 'error';
}
