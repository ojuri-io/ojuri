import {
  initTrainingUpload,
  putTrainingUploadChunk,
  completeTrainingUpload,
  abandonTrainingUpload,
} from '../api/client.js';

const IDLE = { status: 'idle', uploadId: null, filename: '', totalBytes: 0, sentBytes: 0, progress: 0, error: null };

let state = { ...IDLE };
const listeners = new Set();

function notify() {
  for (const l of listeners) l(state);
}

function setState(patch) {
  state = { ...state, ...patch };
  if (state.totalBytes > 0) {
    state.progress = Math.round((state.sentBytes / state.totalBytes) * 100);
  } else {
    state.progress = 0;
  }
  notify();
}

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reset() {
  state = { ...IDLE };
  notify();
}

export function isBusy() {
  return state.status === 'uploading' || state.status === 'completing';
}

export async function start({ file, spec, onSuccess, onError }) {
  if (isBusy()) return;
  setState({ status: 'uploading', uploadId: null, filename: file.name, totalBytes: file.size, sentBytes: 0, error: null });

  let init;
  try {
    init = await initTrainingUpload({ filename: file.name, expectedBytes: file.size });
  } catch (err) {
    const message = String(err?.message || err);
    setState({ status: 'failed', error: message });
    onError?.(message);
    return;
  }
  setState({ uploadId: init.uploadId });

  const chunkSize = init.chunkSize || 5 * 1024 * 1024;
  let offset = 0;
  try {
    while (offset < file.size) {
      if (state.status !== 'uploading') return;
      const end = Math.min(offset + chunkSize, file.size);
      const bytes = await file.slice(offset, end).arrayBuffer();
      await putTrainingUploadChunk({ uploadId: init.uploadId, offset, bytes });
      offset = end;
      setState({ sentBytes: offset });
    }
    setState({ status: 'completing' });
    await completeTrainingUpload(init.uploadId, spec);
    setState({ status: 'completed' });
    onSuccess?.();
  } catch (err) {
    const message = String(err?.message || err);
    setState({ status: 'failed', error: message });
    try { await abandonTrainingUpload(init.uploadId); } catch { /* best-effort */ }
    onError?.(message);
  }
}

export async function abandon() {
  if (!state.uploadId) {
    reset();
    return;
  }
  const id = state.uploadId;
  setState({ status: 'abandoning' });
  try {
    await abandonTrainingUpload(id);
  } catch { /* best-effort */ }
  reset();
}
