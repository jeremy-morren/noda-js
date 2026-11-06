// The single-file module (noda-js.js, the noda-js-module release assets) in Hermes, the JavaScript engine React Native
// uses on Android and iOS: the pinned Hermes CLI (scripts/install-hermes.ps1 installs it to node_modules/.cache/hermes;
// in CI it sets HERMES_PATH). Like QuickJS (quickjs.test.ts), this Hermes has no Intl, TextDecoder, navigator or
// performance (it does have atob), so the library's own fallbacks run for real.
//
// Hermes runs scripts, not ES modules, and Hermes 0.13 (the last release with prebuilt CLI binaries; React Native 0.75's
// engine) doesn't implement two ES2015 features: classes and let/const block scoping. So the module is built as the
// release builds it (standalone/build.ts) but as a script (an IIFE assigning the exports to `NodaJs`), and those two are
// lowered with the same Babel plugins that React Native's Babel preset applies for Hermes; everything else (arrow
// functions, generators, template literals, destructuring, Map/Set, Symbol, Proxy, Reflect, typed arrays) is Hermes's
// own. (Node only; see vitest.config.ts. Skipped when Hermes isn't installed, unless HERMES_PATH says where it is.)

import { beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { transformAsync } from "@babel/core";
import { build } from "esbuild";
import { moduleBuildOptions } from "../../standalone/build.ts";

type CheckResult = { value: string } | { error: string };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hermes = process.env.HERMES_PATH ||
  path.join(root, "node_modules/.cache/hermes", process.platform === "win32" ? "hermes.exe" : "hermes");
// HERMES_PATH set (as in CI) but nothing there fails the tests below rather than skipping them.
const installed = !!process.env.HERMES_PATH || existsSync(hermes);

// Runs inside Hermes, after the module's script has defined `NodaJs`: each check's value as a string, or the error it
// threw, printed as JSON on the last line.
const checkScript = `
var N = NodaJs;
var checks = {};
function check(name, fn) {
  try {
    checks[name] = { value: String(fn()) };
  } catch (e) {
    checks[name] = { error: (e && e.name) + ": " + (e && e.message) };
  }
}
const date = new N.LocalDate(2024, 7, 1);
const instant = N.Instant.FromUtc(2024, 7, 1, 12, 0);
const madrid = () => N.tzdb.Get("Europe/Madrid");
const spanish = N.LocalDatePattern.Create("d 'de' MMMM 'de' uuuu", N.esES);
check("hostApis", () => [typeof Intl, typeof TextDecoder, typeof navigator, typeof performance].join(","));
check("hermes", () => typeof HermesInternal);
check("tzdbVersion", () => N.tzdb.VersionId);
check("zone", () => instant.InZone(madrid()).toString());
check("sydney", () => instant.InZone(N.tzdb.Get("Australia/Sydney")).toString());
check("gapLeniently", () => new N.LocalDate(2024, 3, 31).At(new N.LocalTime(2, 30)).InZoneLeniently(madrid()).toString());
check("gapStrictly", () => new N.LocalDate(2024, 3, 31).At(new N.LocalTime(2, 30)).InZoneStrictly(madrid()).toString());
check("invariant", () => date.toString("d MMMM uuuu", null));
check("spanish", () => spanish.Format(date));
check("parseCaseInsensitive", () => spanish.Parse("1 de JULIO de 2024").Value.Equals(date));
check("json", () => JSON.stringify({ at: instant, on: date, zoned: instant.InZone(madrid()) }));
check("jsonRoundTrip", () => N.ZonedDateTime.fromJSON("2024-07-01T14:00:00+02 Europe/Madrid", N.tzdb).ToInstant().Equals(instant));
check("duration", () => N.Duration.FromMinutes(90).TotalHours);
check("period", () => N.Period.Between(new N.LocalDate(2024, 1, 31), new N.LocalDate(2024, 3, 1)).toString());
check("clock", () => N.SystemClock.Instance.GetCurrentInstant().ToUnixTimeMilliseconds() > 1700000000000);
check("windows", () => new N.WindowsIdDateTimeZoneProvider(N.tzdb).Get("AUS Eastern Standard Time").Id);
check("errorClass", () => {
  try {
    N.tzdb.Get("Not/A_Zone");
    return "no error";
  } catch (e) {
    return [e instanceof Error, e.name].join(",");
  }
});
check("currentCulture", () => N.NodaCultureInfo.CurrentCulture.Name);
check("compiler", () => [typeof N.CompileTzdb, typeof N.CompileTzdbToNzd, typeof N.CompileTzdbSync, typeof N.CompileTzdbToNzdSync].join(","));
print(JSON.stringify(checks));
`;

/** The module as a script for Hermes: built by standalone/build.ts's options as an IIFE, then lowered by Babel. */
async function hermesScript(): Promise<string> {
  const result = await build({ ...moduleBuildOptions("out"), format: "iife", globalName: "NodaJs", write: false, sourcemap: false });
  const moduleCode = result.outputFiles!.find((f) => f.path.endsWith("noda-js.js"))!.text;
  const lowered = await transformAsync(`${moduleCode}\n${checkScript}`, {
    babelrc: false,
    configFile: false,
    sourceType: "script",
    compact: true,
    plugins: ["@babel/plugin-transform-classes", "@babel/plugin-transform-block-scoping"],
  });
  return lowered!.code!;
}

let checks: Record<string, CheckResult>;

beforeAll(async () => {
  if (!installed) {
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "noda-js-hermes-"));
  try {
    const file = path.join(dir, "noda-js-checks.js");
    await writeFile(file, await hermesScript());
    // -w: no compiler warnings (each would print the whole minified line).
    const { stdout } = await promisify(execFile)(hermes, ["-w", file], { maxBuffer: 16 * 1024 * 1024 });
    const json = stdout.trim().split("\n").pop()!;
    checks = JSON.parse(json) as Record<string, CheckResult>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 180_000);

function value(name: string): string {
  const result = checks[name];
  expect(result, name).toBeDefined();
  if ("error" in result!) {
    throw new Error(`${name} threw in Hermes: ${result.error}`);
  }
  return result!.value;
}

function error(name: string): string {
  const result = checks[name];
  expect(result && "error" in result, `${name} should have thrown`).toBe(true);
  return (result as { error: string }).error;
}

describe.skipIf(!installed)("noda-js.js in Hermes", () => {
  it("runs in Hermes, without Intl, TextDecoder, navigator or performance", () => {
    expect(value("hermes")).toBe("object");
    expect(value("hostApis")).toBe("undefined,undefined,undefined,undefined");
  });

  it("loads the bundled tzdb", () => {
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

  it("throws errors that are Errors, with their .NET names", () => {
    expect(value("errorClass")).toBe("true,DateTimeZoneNotFoundException");
  });

  it("has the tzdb compiler", () => {
    expect(value("compiler")).toBe("function,function,function,function");
  });

  it("fails clearly where it needs the host: CurrentCulture", () => {
    expect(error("currentCulture")).toMatch(/^InvalidOperationException: The host reports no languages/);
  });
});
