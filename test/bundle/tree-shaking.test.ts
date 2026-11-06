// Tree-shaking checks: bundle small apps with esbuild (production settings) and check
// that optional data (tzdb, the system provider, cultures) is only included when it's imported.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nzdBase64 } from "../../src/noda-js/TimeZones/TzdbBundledData.generated.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const nzdMarker = nzdBase64.substring(0, 40);

async function bundle(source: string): Promise<string> {
  return (await bundleWithInputs(source)).code;
}

/** The bundle, and the source files that contributed code to it (relative to the repo root, with forward slashes). */
async function bundleWithInputs(source: string): Promise<{ code: string; inputs: string[] }> {
  const result = await build({
    stdin: { contents: source, resolveDir: root, loader: "ts", sourcefile: "app.ts" },
    bundle: true,
    write: false,
    minify: true,
    treeShaking: true,
    format: "esm",
    platform: "neutral",
    target: "es2015",
    logLevel: "silent",
    metafile: true,
  });
  const output = Object.values(result.metafile!.outputs)[0]!;
  const inputs = Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path);
  return { code: result.outputFiles[0]!.text, inputs };
}

// The non-core calendars' calculators and data, by entry point (noda-js/calendars/<name>).
const calendarFiles: Record<string, string[]> = {
  hebrew: ["HebrewMonthConverter.ts", "HebrewScripturalCalculator.ts", "HebrewYearMonthDayCalculator.ts"],
  islamic: ["IslamicYearMonthDayCalculator.ts"],
  persian: ["PersianYearMonthDayCalculator.ts", "PersianYearMonthDayCalculatorAstronomicalData.generated.ts"],
  umalqura: ["UmAlQuraYearMonthDayCalculator.ts", "UmAlQuraYearMonthDayCalculatorData.generated.ts"],
  badi: ["BadiYearMonthDayCalculator.ts", "BadiYearMonthDayCalculatorData.generated.ts"],
};

/** noda-js/system's own files in a bundle (by its inputs). */
function systemFiles(inputs: string[]): string[] {
  return inputs.filter(input => input.startsWith("src/noda-js/System/") || /^src\/noda-js\/TimeZones\/(System|TimeZoneInfoInterceptor)/.test(input));
}

/** Which entry points' calendar files are in a bundle (by its inputs). */
function bundledCalendars(inputs: string[]): string[] {
  return Object.keys(calendarFiles).filter(name =>
    calendarFiles[name]!.some(file => inputs.includes(`src/noda-js/Calendars/${file}`)));
}

describe("tree shaking", () => {
  it("core only: no tzdb data, system provider or cultures", async () => {
    const code = await bundle(`
      import { Instant, LocalDate, DateTimeZone, Offset, LocalDatePattern } from "./src/noda-js/index.ts";
      const zone = DateTimeZone.ForOffset(Offset.FromHours(10));
      console.log(JSON.stringify(Instant.FromUtc(2024, 1, 1, 0, 0).InZone(zone)), LocalDatePattern.Iso.Format(new LocalDate(2024, 3, 1)));
    `);
    expect(code).not.toContain(nzdMarker);
    expect(code).not.toContain("Africa/Abidjan");
    expect(code).not.toContain("supportedValuesOf");
    expect(code).not.toContain("janvier");
    expect(code).not.toContain("AUS Eastern Standard Time");
  }, 60000);

  it("system only: no tzdb data; the system provider, the Windows (FFI) code and Intl probing", async () => {
    const { code, inputs } = await bundleWithInputs(`
      import { SystemDateTimeZoneProvider } from "./src/noda-js/entries/system.ts";
      console.log(SystemDateTimeZoneProvider.GetZoneOrNull("Europe/London"));
    `);
    expect(code).not.toContain(nzdMarker);
    expect(code).toContain("supportedValuesOf");
    expect(code).toContain("node:ffi");
    expect(systemFiles(inputs)).toEqual(expect.arrayContaining([
      "src/noda-js/TimeZones/SystemDateTimeZone.ts",
      "src/noda-js/System/TimeZoneInfo.Win32.ts",
      "src/noda-js/System/Windows/FfiWindowsTimeZoneApi.ts",
      "src/noda-js/System/IntlTimeZone.ts",
    ]));
  }, 60000);

  it("core and tzdb: no system provider, TimeZoneInfo port or FFI code", async () => {
    for (const source of [`
      import { Instant, DateTimeZone, Offset } from "./src/noda-js/index.ts";
      console.log(Instant.FromUtc(2024, 1, 1, 0, 0).InZone(DateTimeZone.ForOffset(Offset.FromHours(10))));
    `, `
      import { tzdb } from "./src/noda-js/entries/tzdb-bundled.ts";
      console.log(tzdb.GetSystemDefault(), tzdb.Get("Europe/London"));
    `]) {
      const { code, inputs } = await bundleWithInputs(source);
      expect(systemFiles(inputs)).toEqual([]);
      expect(code).not.toContain("node:ffi");
      expect(code).not.toContain("GetDynamicTimeZoneInformation");
      expect(code).not.toContain("supportedValuesOf");
    }
  }, 60000);

  it("tzdb runtime (no bundled data): reader present, no NZD", async () => {
    const code = await bundle(`
      import { TzdbDateTimeZoneSource } from "./src/noda-js/entries/tzdb.ts";
      export const load = (bytes: Uint8Array) => TzdbDateTimeZoneSource.FromBytes(bytes);
    `);
    expect(code).not.toContain(nzdMarker);
  }, 60000);

  it("tzdb bundled: NZD present (the checks can tell the difference)", async () => {
    const code = await bundle(`
      import { tzdb } from "./src/noda-js/entries/tzdb-bundled.ts";
      console.log(tzdb.Get("Europe/London"));
    `);
    expect(code).toContain(nzdMarker);
  }, 60000);

  it("tzdb compiler: only in bundles that import noda-js/tzdb/compiler", async () => {
    // The compiler, and the NZD writer it uses (the reader shares only DateTimeZoneWriter.ZoneIntervalConstants).
    const compilerFiles = (inputs: string[]): string[] => inputs.filter(input =>
      input.startsWith("src/noda-js/TzdbCompiler/") || input === "src/noda-js/TimeZones/IO/DateTimeZoneWriter.ts");
    const core = await bundleWithInputs(`
      import { Instant, DateTimeZone, Offset } from "./src/noda-js/index.ts";
      console.log(Instant.FromUtc(2024, 1, 1, 0, 0).InZone(DateTimeZone.ForOffset(Offset.FromHours(10))));
    `);
    expect(compilerFiles(core.inputs)).toEqual([]);
    const bundled = await bundleWithInputs(`
      import { tzdb, TzdbDateTimeZoneSource } from "./src/noda-js/entries/tzdb-bundled.ts";
      export const load = (bytes: Uint8Array) => TzdbDateTimeZoneSource.FromBytes(bytes).Validate();
      console.log(tzdb.Get("Europe/London"));
    `);
    expect(compilerFiles(bundled.inputs)).toEqual([]);

    const compiler = await bundleWithInputs(`
      import { CompileTzdb } from "./src/noda-js/entries/tzdb-compiler.ts";
      CompileTzdb("https://data.iana.org/time-zones/tzdata-latest.tar.gz").then(source => console.log(source.VersionId));
    `);
    expect(compilerFiles(compiler.inputs)).toEqual(expect.arrayContaining([
      "src/noda-js/TzdbCompiler/Tzdb/TzdbZoneInfoCompiler.ts",
      "src/noda-js/TzdbCompiler/Tzdb/TzdbStreamWriter.ts",
      "src/noda-js/TzdbCompiler/Archive.ts",
      "src/noda-js/TzdbCompiler/Inflate.ts",
      "src/noda-js/TzdbCompiler/Tar.ts",
      "src/noda-js/TzdbCompiler/Input.ts",
      "src/noda-js/TimeZones/IO/DateTimeZoneWriter.ts",
    ]));
    // The compiler doesn't bring the bundled tzdb data with it.
    expect(compiler.code).not.toContain(nzdMarker);
  }, 60000);

  it("one culture: only that culture's data", async () => {
    const code = await bundle(`
      import { LocalDatePattern, LocalDate } from "./src/noda-js/index.ts";
      import { frFR } from "./src/noda-js/Cultures/fr-FR.generated.ts";
      console.log(LocalDatePattern.Create("d MMMM uuuu", frFR).Format(new LocalDate(2024, 1, 1)));
    `);
    expect(code).toContain("janvier");
    expect(code).not.toContain("Dezember"); // de-DE (ASCII: esbuild escapes non-ASCII characters, so "März" would never match)
    expect(code).not.toContain(nzdMarker);
  }, 60000);

  it("cultures barrel (noda-js/cultures): only the imported culture's data", async () => {
    const code = await bundle(`
      import { LocalDatePattern, LocalDate } from "./src/noda-js/index.ts";
      import { frFR } from "./src/noda-js/Cultures/index.generated.ts";
      console.log(LocalDatePattern.Create("d MMMM uuuu", frFR).Format(new LocalDate(2024, 1, 1)));
    `);
    expect(code).toContain("janvier");
    expect(code).not.toContain("Dezember"); // de-DE (ASCII: esbuild escapes non-ASCII characters, so "März" would never match)
    expect(code).not.toContain("enero"); // es-ES
    expect(code).not.toContain(nzdMarker);
  }, 60000);

  it("noda-js/cultures/all: one bare import bundles every culture (its side effect: registering them)", async () => {
    const code = await bundle(`
      import { NodaCultureInfo } from "./src/noda-js/index.ts";
      import "./src/noda-js/Cultures/all.generated.ts";
      console.log(NodaCultureInfo.CurrentCulture.Name);
    `);
    expect(code).toContain("janvier"); // fr-FR
    expect(code).toContain("Dezember"); // de-DE
    expect(code).toContain("enero"); // es-ES
    expect(code).not.toContain(nzdMarker);
  }, 60000);

  it("CurrentCulture alone bundles no culture data", async () => {
    const code = await bundle(`
      import { NodaCultureInfo } from "./src/noda-js/index.ts";
      console.log(NodaCultureInfo.CurrentCulture.Name);
    `);
    expect(code).not.toContain("janvier");
    expect(code).not.toContain("enero");
  }, 60000);

  it("core calendars only (ISO, Gregorian, Julian, Coptic): no other calendar's code or data", async () => {
    const { inputs } = await bundleWithInputs(`
      import { CalendarSystem, LocalDate } from "./src/noda-js/index.ts";
      const date = new LocalDate(2024, 3, 1);
      console.log(date.WithCalendar(CalendarSystem.Julian), date.WithCalendar(CalendarSystem.Coptic), CalendarSystem.ForId("Gregorian"), CalendarSystem.Ids);
    `);
    expect(inputs).toContain("src/noda-js/CalendarSystem.ts");
    expect(bundledCalendars(inputs)).toEqual([]);
  }, 60000);

  it("noda-js/calendars/hebrew: only the Hebrew calendar", async () => {
    const { inputs } = await bundleWithInputs(`
      import { LocalDate } from "./src/noda-js/index.ts";
      import { HebrewCivil } from "./src/noda-js/entries/calendars/hebrew.ts";
      console.log(new LocalDate(2024, 3, 1).WithCalendar(HebrewCivil));
    `);
    expect(bundledCalendars(inputs)).toEqual(["hebrew"]);
  }, 60000);

  it("noda-js/calendars/umalqura: only the Um Al Qura calendar and its table", async () => {
    const { inputs } = await bundleWithInputs(`
      import { LocalDate } from "./src/noda-js/index.ts";
      import { UmAlQura } from "./src/noda-js/entries/calendars/umalqura.ts";
      console.log(new LocalDate(2024, 3, 1).WithCalendar(UmAlQura));
    `);
    expect(bundledCalendars(inputs)).toEqual(["umalqura"]);
    expect(inputs).toContain("src/noda-js/Calendars/UmAlQuraYearMonthDayCalculatorData.generated.ts");
  }, 60000);

  it("noda-js/calendars/all: one bare import bundles every calendar (its side effect: registering them for ForId)", async () => {
    const { inputs } = await bundleWithInputs(`
      import { CalendarSystem } from "./src/noda-js/index.ts";
      import "./src/noda-js/entries/calendars/all.ts";
      console.log(CalendarSystem.ForId("Persian Simple"));
    `);
    expect(bundledCalendars(inputs)).toEqual(Object.keys(calendarFiles));
  }, 60000);
});
