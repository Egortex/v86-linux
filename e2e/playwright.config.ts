import { defineConfig, devices } from "@playwright/test";

const PORT = 4310;

/**
 * Playwright config for v86-linux's e2e suite.
 *
 * These tests boot a real x86 Linux guest under v86 inside a real browser
 * tab (see fixtures/harness.html for why the page can't just `import` the
 * TS packages directly yet), so timeouts are generous: cold boot alone is
 * ~43s per the repo README's measured numbers, before any in-guest command
 * runs.
 */
export default defineConfig({
    testDir: "./tests",
    timeout: 120_000,
    expect: {
        timeout: 30_000,
    },
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: [["list"]],
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: "retain-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: {
        command: "node fixtures/serve.mjs",
        url: `http://localhost:${PORT}/harness.html`,
        reuseExistingServer: !process.env.CI,
        env: { PORT: String(PORT) },
        timeout: 30_000,
    },
});
