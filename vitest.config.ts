import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

// The companion package (src/noda-js-zod) imports "noda-js". In tests that must be the core's
// sources, the same modules the tests import, not its build output (two copies of a class break instanceof).
// One alias per entry point in src/noda-js/package.json "exports" (test/tsconfig.json's `paths` mirror these).
const coreExports: Record<string, { default: string }> = JSON.parse(
  readFileSync(new URL("./src/noda-js/package.json", import.meta.url), "utf8"),
).exports;
const coreAliases = Object.entries(coreExports)
  // Longest first, so "noda-js/tzdb/bundled" wins over "noda-js/tzdb" and "noda-js".
  .sort(([a], [b]) => b.length - a.length)
  .map(([subpath, target]) => ({
    find: new RegExp(`^noda-js${subpath.slice(1).replace(/\//g, "\\/")}$`),
    replacement: fileURLToPath(new URL(`./src/noda-js/${target.default.replace("./dist/", "").replace(/\.js$/, ".ts")}`, import.meta.url)),
  }));

// Tests that need Node itself (node:fs, esbuild), so they only run in the `node` project.
const nodeOnly = [
  "test/bundle/tree-shaking.test.ts",
  "test/clock-isolation.test.ts",
  "test/unported.test.ts",
  "test/zod/tree-shaking.test.ts",
  // Removes globals (Intl, navigator, ...) and re-imports the library.
  "test/no-host-apis.test.ts",
  // Run the single-file module in QuickJS (WebAssembly) and in Hermes (a native binary).
  "test/module/quickjs.test.ts",
  "test/module/hermes.test.ts",
];

// Browsers beyond the default three, each a project of its own, defined only when NODA_TEST_BROWSERS lists them
// (comma-separated), because each needs something only some machines have. The CI jobs that have them set it (see
// .github/workflows/ci.yml); e.g. `$env:NODA_TEST_BROWSERS = 'edge'; npx vitest run --project edge` on Windows.
//   edge            Microsoft Edge (Playwright, the installed msedge channel).
//   safari          Safari on macOS (WebdriverIO and safaridriver; needs `sudo safaridriver --enable` once).
//   ios-safari      Mobile Safari in the iOS Simulator (safaridriver; NODA_TEST_IOS_UDID picks the simulator,
//                   scripts/start-ios-simulator.sh boots one).
//   android-chrome  Chrome on an Android device or emulator (WebdriverIO and Appium's UiAutomator2 driver, at
//                   127.0.0.1:4723; scripts/test-android.sh starts Appium and forwards the device's port).
const extraBrowserNames = ["edge", "safari", "ios-safari", "android-chrome"];
const extraBrowsers = new Set((process.env.NODA_TEST_BROWSERS ?? "").split(",").map((b) => b.trim()).filter(Boolean));
for (const name of extraBrowsers) {
  if (!extraBrowserNames.includes(name)) {
    throw new Error(`NODA_TEST_BROWSERS: unknown browser "${name}" (known: ${extraBrowserNames.join(", ")}).`);
  }
}

// The WebdriverIO browsers. Safari and the devices run one test file at a time, in one session (the provider has no
// parallelism), and are slower than desktop engines, so they get longer timeouts.
async function webdriverProject(): Promise<TestProjectInlineConfiguration[]> {
  const wanted = ["safari", "ios-safari", "android-chrome"].filter((b) => extraBrowsers.has(b));
  if (wanted.length === 0) {
    return [];
  }
  const { webdriverio } = await import("@vitest/browser-webdriverio");
  // safaridriver's iOS capabilities (which WebdriverIO's types don't list): a simulator, the booted one if given.
  const iosCapabilities: Record<string, unknown> = {
    platformName: "iOS",
    "safari:useSimulator": true,
    ...(process.env.NODA_TEST_IOS_UDID ? { "safari:deviceUDID": process.env.NODA_TEST_IOS_UDID } : { "safari:deviceType": "iPhone" }),
  };
  const instances = {
    safari: { browser: "safari", name: "safari", provider: webdriverio() },
    "ios-safari": {
      browser: "safari",
      name: "ios-safari",
      provider: webdriverio({
        capabilities: iosCapabilities,
        // Booting a simulator and starting Safari in it can take minutes.
        connectionRetryTimeout: 600_000,
      }),
    },
    "android-chrome": {
      browser: "chrome",
      name: "android-chrome",
      provider: webdriverio({
        hostname: "127.0.0.1",
        port: 4723,
        path: "/",
        connectionRetryTimeout: 600_000,
        capabilities: {
          // WebDriver classic: WebdriverIO would otherwise ask for a BiDi session (it doesn't for Safari).
          "wdio:enforceWebDriverClassic": true,
          platformName: "Android",
          "appium:automationName": "UiAutomator2",
          "appium:newCommandTimeout": 3600,
          // Chrome's first-run screens would otherwise cover the page (scripts/test-android.sh also sets these).
          "appium:chromeOptions": { args: ["--disable-fre", "--no-first-run", "--no-default-browser-check"] },
        },
      }),
    },
  } as const;
  return [
    {
      extends: true,
      test: {
        name: "webdriver",
        exclude: nodeOnly,
        testTimeout: 60_000,
        hookTimeout: 300_000,
        // A fixed port on 127.0.0.1: scripts/test-android.sh forwards the emulator's 127.0.0.1 to it (adb reverse).
        api: { host: "127.0.0.1", port: Number(process.env.NODA_TEST_API_PORT || 23400), strictPort: true },
        browser: {
          enabled: true,
          // Safari has no headless mode; Chrome on Android has no window to hide.
          headless: false,
          // How long the page has to connect back after the session starts: a cold simulator or emulator is slow.
          connectTimeout: 300_000,
          screenshotFailures: false,
          instances: wanted.map((b) => instances[b as keyof typeof instances]),
        },
      },
    },
  ];
}

export default defineConfig({
  // NZD and tzdata (.tar.gz) test fixtures are imported as assets (`?inline`), so they load the same way on Node and in browsers.
  assetsInclude: ["**/*.nzd", "**/*.tar.gz"],
  resolve: { alias: coreAliases },
  test: {
    include: ["test/**/*.test.ts"],
    // Registers every calendar system (noda-js/calendars/all) before each test file.
    setupFiles: ["./test/setup.ts"],
    // Every test runs on Node and, to catch engine and Intl differences, in the three browser engines (V8,
    // SpiderMonkey, JavaScriptCore) via Playwright. `npm run test:node` / `npm run test:browser` run one side.
    // CI also runs them on Windows and macOS, in Edge, Safari, iOS and Android (above), and merges the results.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          // Each instance is a project of its own, named after its browser (so are test results).
          name: "browser",
          exclude: nodeOnly,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [
              { browser: "chromium", name: "chromium" },
              { browser: "firefox", name: "firefox" },
              // One page at a time: with several pages open, Playwright's WebKit (seen on Windows) intermittently
              // never finishes loading a test file's iframe, and the run hangs. Sequential, it takes about a minute.
              { browser: "webkit", name: "webkit", maxWorkers: 1 },
              ...(extraBrowsers.has("edge")
                ? [{ browser: "chromium", name: "edge", provider: playwright({ launchOptions: { channel: "msedge" } }) } as const]
                : []),
            ],
          },
        },
      },
      ...(await webdriverProject()),
    ],
    // Used by `npm run test:ci` and the CI jobs (--coverage); the CI workflow merges and publishes the summaries. v8
    // coverage, from the node project only (see test/vitest/v8-node-only-coverage.ts).
    coverage: {
      provider: "custom",
      customProviderModule: "./test/vitest/v8-node-only-coverage.ts",
      include: ["src/**/*.ts"],
      // Generated data (cultures, tzdb, enums, messages) isn't code worth measuring.
      exclude: ["src/**/*.generated.ts", "src/*/dist/**"],
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "coverage",
      reportOnFailure: true,
    },
  },
});
