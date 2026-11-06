# Tests

| Folder / file | What |
|---|---|
| `scenarios/` | **Generated.** Every NodaTime.Test and NodaTime.TzdbCompiler.Test test method and case (`tools/NodaJs.Tools (scenarios)`); the compiler's are under `scenarios/TzdbCompiler/`. `types.ts` is hand-written. |
| `ported/` | Hand-ported NodaTime tests, mirroring `src/NodaTime.Test` (`ported/Text/LocalDatePatternTest.test.ts`) and, under `ported/TzdbCompiler/`, `src/NodaTime.TzdbCompiler.Test` (`ported/TzdbCompiler/Tzdb/TokensTest.test.ts`). |
| `helpers/` | The scenario harness (`scenarios.ts`), value decoding (`decode.ts`), NUnit-style assertions. |
| `unported.test.ts` | Lists every NodaTime fixture with no ported file yet, as `todo`s. |
| `api/` | NodaTime's public API by reflection (generated) and a test that noda-js matches its shape: properties are getters, methods are methods. Deliberate differences: `api/differences.ts`. |
| `golden/` | **Generated.** NodaTime's own formatting/parsing results per culture, .NET's culture-aware comparisons, NodaTime.Serialization.SystemTextJson's JSON for one value of each type in every calendar system (`json/`, read back by `json.test.ts`), and every year of every calendar system: leap years, year and month lengths and starts (`calendars/`, checked by `calendars.test.ts`, in place of NodaTime's day-by-day comparisons with the BCL's calendars). |
| `tzdb-compiler/` | `noda-js/tzdb/compiler`: compiling `fixtures/tzdb/tzdata<version>.tar.gz` gives the bundled NZD byte for byte (with the host's `DecompressionStream`, with noda-js's own inflate, and from a plain `.tar`); the inflate and tar readers. |
| `system/` | `noda-js/system`: unit tests over a fake Windows registry (`helpers/FakeWindowsTimeZoneApi.ts`), the same code as with FFI; `environment.test.ts`, which starts real Node processes: with different `TZ` values, and on Windows with each backend (the native addon package installed next to the probe or not, node:ffi on or off with `--no-experimental-ffi`), checking which backend is used and that the addon and node:ffi give identical results (the addon is built by `npm run build:native`; in CI a missing build fails, locally those cases are skipped); and `WindowsComparison.test.ts`, which compares every Windows zone with NodaTime's `BclDateTimeZoneSource` on .NET exactly. That needs Windows and `test-results/system-zones.json`, written by `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/export-system-zones.ps1`; without them it's skipped. |
| `clock-isolation.test.ts` | Only `SystemClock` may read the real time, so everything else is testable with `FakeClock`. |
| `fixtures/` | Binary test resources, imported with Vite's `?inline` (a `data:` URL) so they load the same way everywhere. `fixtures/tzdb/tzdata<version>.tar.gz` is the IANA tzdata release the bundled NZD was compiled from (written by `tools/NodaJs.Tools (data tzdb)`). |
| `vitest/` | `npm run test:ci`'s JUnit reporter (suites named per project) and coverage provider (v8, Node only). |

## Where tests run

Every test runs on Node and in Chromium (V8), Firefox (SpiderMonkey) and WebKit (JavaScriptCore), headless, via
[Vitest browser mode](https://vitest.dev/guide/browser/) and Playwright: the Vitest projects are `node`, `chromium`,
`firefox` and `webkit` (see `vitest.config.ts`). `test/bundle/`, `clock-isolation.test.ts` and `unported.test.ts` need
Node (esbuild, `node:fs`), so they only run in `node`.

Two more environments run from the `node` project: `no-host-apis.test.ts` reloads the library with `Intl`,
`navigator`, `TextDecoder`, `atob`, `Uint8Array.fromBase64` and `performance` removed, and `module/quickjs.test.ts`
builds the single-file module (`noda-js.js`, as released) and runs checks in [QuickJS](https://bellard.org/quickjs/),
an embedded engine without any of those APIs (compiled to WebAssembly, via quickjs-emscripten). Both run in every
`npm test` and `npm run test:ci`. `module/hermes.test.ts` does the same in [Hermes](https://github.com/facebook/hermes),
React Native's engine on Android and iOS (no `Intl` either): the pinned Hermes VM is installed by
`pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-hermes.ps1` (SHA-256 checked, into
`node_modules/.cache/hermes`); without it the test is skipped locally and fails in CI. Hermes 0.13 lacks ES2015 classes
and block scoping, so the test lowers them with Babel, as React Native's Babel preset does.

| Command | Runs |
|---|---|
| `npm test` | All four projects. |
| `npm run test:node` | Node only (no browsers needed). |
| `npm run test:browser` | The three browsers. |
| `npx vitest run --project firefox test/ported/LocalDateTest.test.ts` | One file in one project. |
| `npm run test:ci` | All four, with coverage (from `node`) and `test-results/junit.xml`. |

The browsers are Playwright's builds: install them once with `npx playwright install chromium firefox webkit` (on Linux,
add `--with-deps` for their system packages). Tests must not import `node:*` modules unless they're Node-only (add them to
`nodeOnly` in `vitest.config.ts`). More browsers are opt-in through `NODA_TEST_BROWSERS` (comma-separated): `edge`
(Playwright's branded Microsoft Edge), `safari` (desktop Safari through WebdriverIO and safaridriver, macOS),
`ios-safari` (Mobile Safari in the iOS Simulator, `NODA_TEST_IOS_UDID`) and `android-chrome` (Chrome on an Android
emulator through Appium, `scripts/test-android.sh`).

### CI

`.github/workflows/ci.yml` runs the suite on every push, as one job per place, each writing a Vitest blob report
labelled with where it ran (`scripts/test-blob.ps1`):

| Where | Projects |
|---|---|
| Linux, Windows, macOS | `node` (with coverage, QuickJS and Hermes), `chromium`, `firefox`, `webkit` |
| Windows (x64 and ARM64) | `node` also builds the native addon (`npm run build:native`) and exports .NET's time zones (`scripts/export-system-zones.ps1`), for `test/system/` |
| Windows | `edge` |
| macOS | `safari`, `ios-safari` (iOS Simulator) |
| Linux | `android-chrome` (Android emulator) |

The `report` job then merges every blob (`scripts/merge-test-reports.ps1`, `vitest --merge-reports --coverage`) into one
JUnit report, whose suites are named `"<file> [<project>, <where>]"`, and one coverage report (paths rebased onto the
merging checkout), and publishes both. The `checks` job runs typecheck, build, `check:package` (ESLint, publint,
arethetypeswrong, the package consumer), `check:reproducible` and `build:module`.

## Porting a NodaTime test class

1. Open the scenario file, e.g. `scenarios/LocalDateTest.generated.ts`. Each test lists its C# `source`
   (`file:line` in `.nodatime/<tag>/`).
2. Create `ported/LocalDateTest.test.ts` and give the body of each test method, translated from the C#:

   ```ts
   import { fixture } from "../scenarios/LocalDateTest.generated.ts";
   import { port } from "../helpers/scenarios.ts";
   import { assertNodaEqual, assertThrows } from "../helpers/assertions.ts";
   import { LocalDate } from "../../src/internal.ts";

   port(fixture, {
     // [TestCase(...)] cases: arguments arrive decoded, in C# parameter order.
     PlusDays_Simple(start: LocalDate, days: number, expected: LocalDate) {
       assertNodaEqual(start.PlusDays(days), expected);
     },
     // [TestCase(..., ExpectedResult = x)]: return the value; the harness compares it.
     DayOfWeek_AroundEpoch(year: number) {
       return new LocalDate(year, 1, 1).DayOfWeek;
     },
     // Plain [Test]: no arguments.
     MinIsoValue() {
       assertThrows("ArgumentOutOfRangeException", () => LocalDate.MinIsoValue.PlusDays(-1));
     },
   });
   ```
3. Run `npx vitest run test/ported/LocalDateTest.test.ts`. Methods you haven't given a body show as
   `todo`; cases with values noda-js can't represent (BCL types, for example) are skipped with the
   reason. A body whose name matches no NodaTime test fails, which catches typos and upstream renames.

When NodaTime adds tests, re-run `tools/generate.ps1 -Only scenarios`: new cases run against existing
bodies automatically, and new methods appear as `todo`.
