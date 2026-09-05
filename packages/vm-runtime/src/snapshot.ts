import type { V86 } from "v86";

/**
 * Wraps v86's save_state()/restore_state() for warm-start caching (Phase 5).
 * Callers decide where the returned bytes are persisted (IndexedDB/Cache API
 * in the browser); this module only handles the emulator side.
 */
export async function saveSnapshot(emulator: V86): Promise<Uint8Array> {
    const buf = await emulator.save_state();
    return new Uint8Array(buf);
}

export async function restoreSnapshot(emulator: V86, snapshot: Uint8Array): Promise<void> {
    await emulator.restore_state(snapshot.buffer as ArrayBuffer);
}
