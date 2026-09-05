import { test, expect } from "@playwright/test";

/**
 * Exercises the preview-bridge path (packages/preview-bridge/src/port-forward.ts)
 * from an actual page context: start a real HTTP server inside the guest,
 * then reach it from host/browser JS via v86's `fetch` network backend's
 * `network_adapter.connect(port)` synthetic TCP client — no relay server
 * involved for this direction, per that package's README.
 *
 * packages/preview-bridge/spike-phase4-preview.mjs additionally validates a
 * two-stage dance: boot under a real-internet (`wsproxy`) backend, run a
 * real `npm install`, `save_state()`, then `restore_state()` into a FRESH
 * instance configured with the `fetch` backend, refreshing DHCP so the
 * guest's lease matches the new backend's virtual subnet. That dance is
 * only needed because `fetch` cannot do outbound HTTPS (so it can't be used
 * for the install step) but CAN reach a port the guest already has open.
 *
 * This test doesn't need an install step at all (the "server" here is a
 * one-liner using Node, already present in the vm-image build) — so it
 * boots directly with the `fetch` backend from the start and skips the
 * snapshot/restore/backend-swap entirely. That swap is exactly what
 * @v86-linux/runtime's enterPreviewMode() automates for the real
 * install-then-preview flow (see packages/runtime/src/runtime.ts); a test
 * that also drove an install would be redundant with
 * packages/network's/preview-bridge's own spikes and would add ~minutes of
 * npm-install wall time for no additional coverage of the
 * host->guest-port-reachability behavior this test targets.
 */
test("reaches a real HTTP server started inside the guest via network_adapter.connect", async ({ page }) => {
    await page.goto("/harness.html");
    await page.waitForFunction(() => Boolean((window as any).__harness));

    await page.evaluate(async () => {
        const harness = (window as any).__harness;
        const vm = harness.bootVM({ netDevice: "fetch" });
        (window as any).__vm = vm;
        await vm.ready;
    });

    await expect(page.locator("#log")).toContainText(/[\w.-]+:~#/, { timeout: 90_000 });

    // Start a real Node HTTP server in the background inside the guest,
    // listening on 0.0.0.0:8080, and wait for our own marker to confirm the
    // backgrounded process actually launched (not just that the shell
    // accepted the command).
    const started = await page.evaluate(async () => {
        const vm = (window as any).__vm;
        vm.runCommand(
            "node -e \"require('http').createServer((q,r)=>r.end('preview-ok from guest')).listen(8080)\" " +
            ">/tmp/server.log 2>&1 & echo SERVER_STARTED",
        );
        const tail = await vm.waitForSerial(/SERVER_STARTED/, 30_000);
        return tail.includes("SERVER_STARTED");
    });
    expect(started).toBe(true);

    // Give the guest's network stack a moment past boot before probing —
    // mirrors refreshGuestNetworkForPreview's settle delay in port-forward.ts,
    // even though no backend swap happened here.
    await page.waitForTimeout(2_000);

    const response = await page.evaluate(async () => {
        const harness = (window as any).__harness;
        const vm = (window as any).__vm;
        return harness.fetchOverGuestPort(vm.emulator, 8080, "/", 15_000);
    });

    // A real HTTP/1.0 response: status line + headers + the guest server's
    // literal body, round-tripped through v86's synthetic TCP client with
    // no relay server for this host->guest direction.
    expect(response).toContain("preview-ok from guest");
});
