// A consumer of the *built* packages (resolved through node_modules and each package's "exports", so through dist/),
// type-checked with skipLibCheck off by `npm run check:package`: the published declarations must be complete and valid
// (e.g. nothing they reference may be stripped as @internal).
import * as core from "noda-js";
import * as tzdbReader from "noda-js/tzdb";
import * as tzdbBundled from "noda-js/tzdb/bundled";
import * as tzdbCompiler from "noda-js/tzdb/compiler";
import * as system from "noda-js/system";
import * as windows from "noda-js/windows";
import * as cultures from "noda-js/cultures";
import "noda-js/cultures/all";
import * as testing from "noda-js/testing";
import * as linq from "noda-js/linq";
import NodaZ from "noda-js-zod";

export const entryPoints = [core, tzdbReader, tzdbBundled, tzdbCompiler, system, windows, cultures, testing, linq, NodaZ];

// A few uses, so the declarations are exercised rather than just loaded.
const date: core.LocalDate = new core.LocalDate(2024, 3, 1).PlusDays(30);
const text: string = core.LocalDatePattern.Create("d MMMM uuuu", cultures.enAU).Format(date);
const zoned: core.ZonedDateTime = core.Instant.FromUtc(2024, 3, 31, 12, 0).InZone(tzdbBundled.tzdb.Get("Australia/Sydney"));
const systemZone: core.DateTimeZone = system.SystemDateTimeZoneProvider.GetSystemDefault();
const systemDisplayName: string = system.SystemDateTimeZone.ForSystemDefault().DisplayName;
const originalZone: system.TimeZoneInfo | null = new system.SystemDateTimeZoneSource().ForId("UTC").OriginalZone;
const order: number = linq.DurationComparer(core.Duration.FromHours(1), core.Duration.Zero);
const parsed: core.Instant = NodaZ.Instant.parse("2024-03-31T12:00:00Z");
const zonedSchema = NodaZ.ZonedDateTime(tzdbBundled.tzdb);
const compiled: Promise<tzdbReader.TzdbDateTimeZoneSource> = tzdbCompiler.CompileTzdb("https://data.iana.org/time-zones/tzdata-latest.tar.gz", {
  WindowsZones: windows.GetCldrWindowsZones(),
  Log: (line: string) => line,
});
const nzd: Promise<Uint8Array> = tzdbCompiler.CompileTzdbToNzd(new Uint8Array(0));
const compileSync: (source: string | URL | Uint8Array | ArrayBuffer) => tzdbReader.TzdbDateTimeZoneSource = tzdbCompiler.CompileTzdbSync;
const nzdSync: (source: Uint8Array) => Uint8Array = tzdbCompiler.CompileTzdbToNzdSync;
// Errors are NodaErrors: the .NET exception types are types (checked by Code), NodaTime's are classes.
const caught: unknown = new core.NodaError("InvalidDataException", "bad archive");
const codes: core.NodaErrorCodes<"SkippedTimeException"> = ["SkippedTimeException", "ArgumentOutOfRangeException", "ArgumentException", "SystemException"];
const invalidData: tzdbCompiler.InvalidDataException | null = core.IsNodaError(caught, "InvalidDataException") ? caught : null;
const argument: core.ArgumentException | null = core.IsNodaError(caught, "ArgumentException") ? caught : null;
// A check for ArgumentOutOfRangeException also catches a SkippedTimeException (its first base code).
const outOfRange: core.ArgumentOutOfRangeException | null = core.IsNodaError(caught, "ArgumentOutOfRangeException") ? caught : null;
const skipped: core.SkippedTimeException | null = core.IsNodaError(caught, "SkippedTimeException") ? caught : null;
const firstBase: "ArgumentOutOfRangeException" | undefined = skipped?.Codes[1];
export const used = [text, zoned, systemZone, systemDisplayName, originalZone?.StandardName, order, parsed, zonedSchema, compiled, nzd, compileSync, nzdSync, invalidData, argument?.ParamName, outOfRange?.ActualValue, skipped?.Zone, firstBase, codes];
