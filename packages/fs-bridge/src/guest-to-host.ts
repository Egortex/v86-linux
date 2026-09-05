import type { V86 } from "v86";

/** Reads a single file back out of the guest's 9p filesystem. */
export async function readGuestFile(emulator: V86, guestPath: string): Promise<Uint8Array> {
    return emulator.read_file(guestPath);
}

export async function readGuestTextFile(emulator: V86, guestPath: string): Promise<string> {
    const bytes = await readGuestFile(emulator, guestPath);
    return new TextDecoder().decode(bytes);
}
