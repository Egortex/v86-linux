import type { V86 } from "v86";

/** Writes a single file into the guest's 9p filesystem. */
export async function writeGuestFile(
    emulator: V86,
    guestPath: string,
    contents: Uint8Array | string,
): Promise<void> {
    const data = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
    await emulator.create_file(guestPath, data);
}
