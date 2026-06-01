import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

beforeAll(() => {
  Blob.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
});

vi.mock('../src/api/client.js', () => ({
  initTrainingUpload: vi.fn(),
  putTrainingUploadChunk: vi.fn(),
  completeTrainingUpload: vi.fn(),
  abandonTrainingUpload: vi.fn(),
}));

import {
  initTrainingUpload,
  putTrainingUploadChunk,
  completeTrainingUpload,
  abandonTrainingUpload,
} from '../src/api/client.js';
import {
  getState, subscribe, start, abandon, reset, isBusy,
} from '../src/state/training-upload-runner.js';

const fakeFile = (name, size) => {
  const bytes = new Uint8Array(size);
  const blob = new Blob([bytes]);
  return new File([blob], name, { type: 'text/csv' });
};

beforeEach(() => {
  reset();
  vi.clearAllMocks();
});

describe('training-upload-runner', () => {
  it('starts in idle state', () => {
    expect(getState().status).toBe('idle');
    expect(isBusy()).toBe(false);
  });

  it('runs an upload to completion and surfaces progress to subscribers', async () => {
    initTrainingUpload.mockResolvedValue({ uploadId: 'u1', chunkSize: 4 });
    putTrainingUploadChunk.mockResolvedValue(undefined);
    completeTrainingUpload.mockResolvedValue(undefined);

    const states = [];
    const unsub = subscribe((s) => states.push({ status: s.status, progress: s.progress }));

    await start({ file: fakeFile('t.csv', 10), spec: { dropEmptyRows: true } });

    unsub();
    expect(getState().status).toBe('completed');
    expect(getState().progress).toBe(100);
    expect(putTrainingUploadChunk).toHaveBeenCalledTimes(3);
    const progressMidway = states.find((s) => s.progress > 0 && s.progress < 100);
    expect(progressMidway).toBeTruthy();
  });

  it('survives a subscriber unmount/resubscribe and keeps progressing', async () => {
    initTrainingUpload.mockResolvedValue({ uploadId: 'u2', chunkSize: 4 });
    let chunkResolvers = [];
    putTrainingUploadChunk.mockImplementation(() => new Promise((r) => chunkResolvers.push(r)));
    completeTrainingUpload.mockResolvedValue(undefined);

    const seenBefore = [];
    const unsub1 = subscribe((s) => seenBefore.push(s.progress));
    const run = start({ file: fakeFile('big.csv', 10), spec: {} });

    await new Promise((r) => setTimeout(r, 0));
    chunkResolvers.shift()?.();
    await new Promise((r) => setTimeout(r, 0));

    unsub1();

    const seenAfter = [];
    const unsub2 = subscribe((s) => seenAfter.push(s.progress));

    chunkResolvers.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
    chunkResolvers.shift()?.();
    await run;
    unsub2();

    expect(getState().status).toBe('completed');
    expect(seenAfter.length).toBeGreaterThan(0);
  });

  it('records the error and calls abandon when a chunk PUT fails', async () => {
    initTrainingUpload.mockResolvedValue({ uploadId: 'u3', chunkSize: 4 });
    putTrainingUploadChunk.mockRejectedValueOnce(new Error('boom'));
    abandonTrainingUpload.mockResolvedValue(undefined);

    const onError = vi.fn();
    await start({ file: fakeFile('x.csv', 8), spec: {}, onError });

    expect(getState().status).toBe('failed');
    expect(getState().error).toContain('boom');
    expect(abandonTrainingUpload).toHaveBeenCalledWith('u3');
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('refuses to start a second upload while one is in flight', async () => {
    initTrainingUpload.mockResolvedValue({ uploadId: 'u4', chunkSize: 4 });
    let resolveChunk;
    putTrainingUploadChunk.mockImplementation(() => new Promise((r) => { resolveChunk = r; }));

    const first = start({ file: fakeFile('a.csv', 8), spec: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(isBusy()).toBe(true);

    await start({ file: fakeFile('b.csv', 8), spec: {} });
    expect(getState().filename).toBe('a.csv');

    resolveChunk();
    completeTrainingUpload.mockResolvedValue(undefined);
    resolveChunk = null;
    putTrainingUploadChunk.mockResolvedValue(undefined);
    await first;
  });
});
