// The single-file module (noda-js.js, the noda-js-module release assets) in a real embedded engine: QuickJS (compiled to
// WebAssembly, via quickjs-emscripten). QuickJS has no Intl, TextDecoder, atob, Uint8Array.fromBase64, performance or
// navigator, so this runs the library's own fallbacks for real. The module is built exactly as the release builds it
// (standalone/build.ts), loaded with an ES module import, and a check script inside QuickJS reports each result.
// (Node only; see vitest.config.ts.)

import { beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { getQuickJS } from "quickjs-emscripten";
import { moduleBuildOptions } from "../../standalone/build.ts";
import type { InvalidOperationException } from "../../src/noda-js/internal.ts";

type CheckResult = { value: string } | { error: string };

// Runs inside QuickJS: each check's value as a string, or the error it threw.
const checkScript = `
import * as N from "noda-js";
const checks = {};
function check(name, fn) {
  try {
    checks[name] = { value: String(fn()) };
  } catch (e) {
    checks[name] = { error: (e && e.name) + ": " + (e && e.message) };
  }
}
const date = new N.LocalDate(2024, 7, 1);
const instant = N.Instant.FromUtc(2024, 7, 1, 12, 0);
const spanish = N.LocalDatePattern.Create("d 'de' MMMM 'de' uuuu", N.esES);
check("hostApis", () => [typeof Intl, typeof TextDecoder, typeof atob, typeof navigator, typeof performance].join(","));
check("tzdbVersion", () => N.tzdb.VersionId);
check("zone", () => instant.InZone(N.tzdb.Get("Europe/Madrid")).toString());
check("sydney", () => instant.InZone(N.tzdb.Get("Australia/Sydney")).toString());
check("gapLeniently", () => new N.LocalDate(2024, 3, 31).At(new N.LocalTime(2, 30)).InZoneLeniently(N.tzdb.Get("Europe/Madrid")).toString());
check("gapStrictly", () => new N.LocalDate(2024, 3, 31).At(new N.LocalTime(2, 30)).InZoneStrictly(N.tzdb.Get("Europe/Madrid")).toString());
check("invariant", () => date.toString("d MMMM uuuu", null));
check("spanish", () => spanish.Format(date));
check("parseCaseInsensitive", () => spanish.Parse("1 de JULIO de 2024").Value.Equals(date));
check("json", () => JSON.stringify({ at: instant, on: date, zoned: instant.InZone(N.tzdb.Get("Europe/Madrid")) }));
check("jsonRoundTrip", () => N.ZonedDateTime.fromJSON("2024-07-01T14:00:00+02 Europe/Madrid", N.tzdb).ToInstant().Equals(instant));
check("duration", () => N.Duration.FromMinutes(90).TotalHours);
check("period", () => N.Period.Between(new N.LocalDate(2024, 1, 31), new N.LocalDate(2024, 3, 1)).toString());
check("clock", () => N.SystemClock.Instance.GetCurrentInstant().ToUnixTimeMilliseconds() > 1700000000000);
check("windows", () => new N.WindowsIdDateTimeZoneProvider(N.tzdb).Get("AUS Eastern Standard Time").Id);
check("currentCulture", () => N.NodaCultureInfo.CurrentCulture.Name);
check("system", () => N.SystemDateTimeZoneProvider.Ids.length);
check("compiler", () => [typeof N.CompileTzdb, typeof N.CompileTzdbToNzd, typeof N.CompileTzdbSync, typeof N.CompileTzdbToNzdSync].join(","));
globalThis.__checks = JSON.stringify(checks);
`;

let checks: Record<string, CheckResult>;

beforeAll(async () => {
  const result = await build({ ...moduleBuildOptions("out"), write: false, sourcemap: false });
  const moduleCode = result.outputFiles!.find((f) => f.path.endsWith("noda-js.js"))!.text;

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setModuleLoader((name) => (name === "noda-js" ? moduleCode : { error: new Error(`Unknown module ${name}`) }));
  const vm = runtime.newContext();
  try {
    vm.unwrapResult(vm.evalCode(checkScript, "checks.mjs", { type: "module" })).dispose();
    runtime.executePendingJobs();
    const handle = vm.getProp(vm.global, "__checks");
    const json = vm.dump(handle) as string | undefined;
    handle.dispose();
    if (typeof json !== "string") {
      throw new Error("The check script didn't finish in QuickJS.");
    }
    checks = JSON.parse(json) as Record<string, CheckResult>;
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}, 180_000);

function value(name: string): string {
  const result = checks[name];
  expect(result, name).toBeDefined();
  if ("error" in result!) {
    throw new Error(`${name} threw in QuickJS: ${result.error}`);
  }
  return result!.value;
}

function error(name: string): string {
  const result = checks[name];
  expect(result && "error" in result, `${name} should have thrown`).toBe(true);
  return (result as { error: string }).error;
}

describe("noda-js.js in QuickJS", () => {
  it("runs without Intl, TextDecoder, atob, navigator or performance", () => {
    expect(value("hostApis")).toBe("undefined,undefined,undefined,undefined,undefined");
  });

  it("loads the bundled tzdb (decoded with its own base64 and UTF-8 decoders)", () => {
    expect(value("tzdbVersion")).toMatch(/^TZDB: \d{4}[a-z]/);
  });

  it("converts between time zones, including across a DST gap", () => {
    expect(value("zone")).toBe("2024-07-01T14:00:00 Europe/Madrid (+02)");
    expect(value("sydney")).toBe("2024-07-01T22:00:00 Australia/Sydney (+10)");
    expect(value("gapLeniently")).toBe("2024-03-31T03:30:00 Europe/Madrid (+02)");
    expect(error("gapStrictly")).toMatch(/^SkippedTimeException: /);
  });

  it("formats and parses, in the invariant culture and others", () => {
    expect(value("invariant")).toBe("1 July 2024");
    expect(value("spanish")).toBe("1 de julio de 2024");
    expect(value("parseCaseInsensitive")).toBe("true");
  });

  it("reads and writes JSON", () => {
    expect(value("json")).toBe('{"at":"2024-07-01T12:00:00Z","on":"2024-07-01","zoned":"2024-07-01T14:00:00+02 Europe/Madrid"}');
    expect(value("jsonRoundTrip")).toBe("true");
  });

  it("does arithmetic, reads the clock and maps Windows zone IDs", () => {
    expect(value("duration")).toBe("1.5");
    expect(value("period")).toBe("P1M1D");
    expect(value("clock")).toBe("true");
    expect(value("windows")).toBe("Australia/Sydney");
  });

  it("has the tzdb compiler (compiling in QuickJS works, but takes ~17 s, so test/no-host-apis.test.ts tests it instead)", () => {
    expect(value("compiler")).toBe("function,function,function,function");
  });

  it("fails clearly where it needs the host: CurrentCulture and noda-js/system", () => {
    expect(error("currentCulture")).toMatch(/^InvalidOperationException: The host reports no languages/);
    expect(error("system")).toMatch(/^InvalidOperationException: noda-js\/system needs the host's Intl/);
  });
});
