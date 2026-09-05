import { test, expect } from "@playwright/test";

/**
 * Boots the real guest image (packages/vm-image's Alpine+Node build, via
 * the /image/* route in fixtures/serve.mjs) inside an actual browser tab,
 * waits for the guest shell prompt on the serial console, then runs a real
 * command and asserts its real output — the same checkpoint as
 * packages/vm-runtime's own boot verification, but now proven to work under
 * v86's browser code path (WebAssembly.instantiateStreaming, Worker-backed
 * CPU loop, etc.) rather than only under plain Node like the repo's other
 * spikes.
 *
 * See fixtures/harness.html's top comment for why this drives v86 directly
 * via its UMD build instead of importing packages/vm-runtime's compiled
 * output (there isn't one yet).
 *
 * Cold boot is the slow path here (~43s measured in this repo's README on
 * the environment it was built in); this test's timeout budget in
 * ../playwright.config.ts already accounts for that.
 */
test("boots the guest and runs a real command over the serial console", async ({ page }) => {
    await page.goto("/harness.html");

    // window.__harness is defined by an inline <script> in harness.html;
    // wait for it to exist before touching it (script tags execute in
    // order, but be defensive against slow asset loads).
    await page.waitForFunction(() => Boolean((window as any).__harness));

    const bootResult = await page.evaluate(async () => {
        const harness = (window as any).__harness;
        const vm = harness.bootVM({});
        (window as any).__vm = vm; // keep a handle for the rest of the test

        await vm.ready;
        return { sawReady: true };
    });
    expect(bootResult.sawReady).toBe(true);

    // The <pre id="log"> element mirrors every serial byte as it arrives
    // (see harness.html's appendLog); assert the guest actually reached an
    // interactive shell, visible in the DOM the same way a real user
    // watching this page would see it.
    const logLocator = page.locator("#log");
    await expect(logLocator).toContainText(/[\w.-]+:~#/, { timeout: 90_000 });

    // Now prove the guest is not just showing a prompt but actually
    // executing commands: ask it to echo a marker string and wait for that
    // exact marker to come back over the serial console.
    const marker = `E2E_MARKER_${Date.now()}`;
    const commandOutput = await page.evaluate(async (marker) => {
        const vm = (window as any).__vm;
        vm.runCommand(`echo ${marker}`);
        const tail = await vm.waitForSerial(new RegExp(marker), 30_000);
        return tail;
    }, marker);

    expect(commandOutput).toContain(marker);
    await expect(logLocator).toContainText(marker);
});
