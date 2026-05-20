import '@testing-library/jest-dom/vitest';

// jsdom doesn't ship ResizeObserver, which a few tweak controls rely on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver || ResizeObserverStub;

// Quiet the noisy "API call failed, using empty fallback" warnings during tests.
const originalWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[sentinel]')) return;
  originalWarn(...args);
};
