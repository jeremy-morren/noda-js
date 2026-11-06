// noda-js/system's SystemDateTimeZoneSource (NodaTime's BclDateTimeZoneSource) reading a fake Windows
// (test/helpers/FakeWindowsTimeZoneApi.ts): the same code as with node:ffi on Windows, so these run on every host.
// IDs, names, rules → zone intervals, the local zone, the TZ environment variable, the Intl fallback, and the tzdb
// source's guessing of the host's zone by its transitions.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ReplaceTZEnvironmentVariable } from "../../src/noda-js/Utility/TimeZoneEnvironment.ts";
import {
  DateTimeZone,
  DateTimeZoneCache,
  DateTimeZoneNotFoundException,
  Instant,
  Offset,
  SystemDateTimeZone,
  SystemClock,
  SystemDateTimeZoneSource,
  TimeZoneInfoInterceptor,
  TzdbDateTimeZoneSource,
  type IDateTimeZoneProvider,
  type ITimeZoneInfoShim,
} from "../../src/noda-js/internal.ts";
import { IntlSystemTimeZones } from "../../src/noda-js/System/IntlSystemTimeZones.ts";
import { ResolveTimeZoneInfoId } from "../../src/noda-js/System/LocalTimeZoneFromTZ.ts";
import { GetHostTimeZone, type IHostTimeZone } from "../../src/noda-js/TimeZones/HostTimeZone.ts";
import { tzdb, tzdbSource } from "../../src/noda-js/entries/tzdb-bundled.ts";
import { nzdBase64 } from "../../src/noda-js/TimeZones/TzdbBundledData.generated.ts";
import { DecodeBase64 } from "../../src/noda-js/Utility/Encoding.ts";
import { TimeZoneInfoReplacer } from "../ported/TimeZones/TimeZoneInfoReplacer.ts";
import {
  AusEasternZone,
  DynamicInformation,
  FakeWindowsTimeZoneApi,
  FakeZones,
  SaWesternZone,
  UtcZone,
  type FakeWindowsOptions,
  type FakeZone,
} from "../helpers/FakeWindowsTimeZoneApi.ts";

/** Runs body with noda-js/system reading the given fake Windows. */
function WithWindows<T>(zones: readonly FakeZone[], options: FakeWindowsOptions, body: (source: SystemDateTimeZoneSource, api: FakeWindowsTimeZoneApi) => T): T {
  const api = new FakeWindowsTimeZoneApi(zones, options);
  return WithShim(api.CreateShim(), () => body(new SystemDateTimeZoneSource(), api));
}

function WithShim<T>(shim: ITimeZoneInfoShim | null, body: () => T): T {
  const restore = TimeZoneInfoReplacer.ReplaceShim(shim);
  SystemDateTimeZone.ResetSystemDefaultCache();
  try {
    return body();
  } finally {
    restore();
    SystemDateTimeZone.ResetSystemDefaultCache();
  }
}

/** The zone's offsets each week from start to end, as seconds. */
function WeeklyOffsets(zone: DateTimeZone, startYear: number, endYear: number): number[] {
  const offsets: number[] = [];
  for (let instant = Instant.FromUtc(startYear, 1, 1, 0, 0); instant.CompareTo(Instant.FromUtc(endYear, 1, 1, 0, 0)) < 0; instant = instant.PlusTicks(7 * 864_000_000_000)) {
    offsets.push(zone.GetUtcOffset(instant).Seconds);
  }
  return offsets;
}

const local = (zone: FakeZone, extra: Parameters<typeof DynamicInformation>[1] = {}): FakeWindowsOptions => ({ Local: DynamicInformation(zone, { Year: 2024, ...extra }) });

// The tests choose the TZ environment variable themselves (ReplaceTZEnvironmentVariable), whatever the developer's or
// runner's TZ is: it's unset unless a test sets it. (Not by changing process.env.TZ: Node then resets Intl's default
// zone for the whole worker.)
let restoreTZ: (() => void) | null = null;
function SetTZ(value: string | undefined): void {
  restoreTZ?.();
  restoreTZ = ReplaceTZEnvironmentVariable(value);
}
beforeEach(() => SetTZ(undefined));
afterEach(() => {
  restoreTZ?.();
  restoreTZ = null;
});

describe("SystemDateTimeZoneSource on Windows (fake registry)", () => {
  it("advertises the registry's zones, sorted as TimeZoneInfo.GetSystemTimeZones sorts them, plus the local zone", () => {
    WithWindows(FakeZones, local(SaWesternZone), source => {
      expect(source.Backend).toBe("ffi");
      expect(source.VersionId).toBe("TimeZoneInfo: Windows (fake)");
      // By base offset, then display name (ordinal).
      expect(source.GetIds()).toEqual([
        "SA Western Standard Time",
        "E. South America Standard Time",
        "UTC-02",
        "UTC",
        "AUS Eastern Standard Time",
        "Samoa Standard Time",
      ]);
      expect(source.GetSystemDefaultId()).toBe("SA Western Standard Time");
    });
  });

  it("leaves out zones whose data is invalid, as .NET does", () => {
    const bad: FakeZone = { Id: "Bad Standard Time", Display: "(UTC) Bad", Std: "Bad", Tzi: new Uint8Array(40) };
    const badDynamic: FakeZone = { ...AusEasternZone, Id: "Bad Dynamic Standard Time", Dynamic: { First: 2007, Last: 2009, Years: AusEasternZone.Dynamic!.Years } };
    const badFirst: FakeZone = { ...AusEasternZone, Id: "Bad First Standard Time", Dynamic: { First: "2007", Last: 2008, Years: AusEasternZone.Dynamic!.Years } };
    const badTransition: FakeZone = { Id: "Bad Transition Standard Time", Std: "x", Tzi: { Bias: 0, DaylightBias: -60, StandardDate: [0, 13, 0, 1, 2, 0, 0, 0], DaylightDate: [0, 3, 0, 1, 2, 0, 0, 0] } };
    const zones = [UtcZone, bad, badDynamic, badFirst, badTransition];
    // Before every zone has been read, FindSystemTimeZoneById reads the registry, and throws InvalidTimeZoneException
    // (which NodaTime's ForId doesn't catch).
    WithWindows(zones, local(UtcZone), source => {
      expect(() => source.ForId("Bad Standard Time")).toThrowNodaError("InvalidTimeZoneException");
      expect(() => source.ForId("Bad Dynamic Standard Time")).toThrowNodaError("InvalidTimeZoneException");
      expect(() => source.ForId("Bad First Standard Time")).toThrowNodaError("InvalidTimeZoneException");
      expect(() => source.ForId("Bad Transition Standard Time")).toThrowNodaError("InvalidTimeZoneException");
    });
    // After, it only looks in its cache, so they're not found.
    WithWindows(zones, local(UtcZone), source => {
      expect(source.GetIds()).toEqual(["UTC"]);
      expect(() => source.ForId("Bad Standard Time")).toThrowNodaError("ArgumentException");
    });
  });

  it("ForId: Windows IDs case-insensitively, IANA IDs (keeping the IANA ID), UTC; ArgumentException otherwise", () => {
    WithWindows(FakeZones, local(SaWesternZone), source => {
      source.GetIds();
      expect(source.ForId("aus eastern standard time").Id).toBe("AUS Eastern Standard Time");
      const sydney = source.ForId("Australia/Sydney");
      expect(sydney.Id).toBe("Australia/Sydney");
      expect(sydney.OriginalZone!.HasIanaId).toBe(true);
      expect(WeeklyOffsets(sydney, 2000, 2030)).toEqual(WeeklyOffsets(source.ForId("AUS Eastern Standard Time"), 2000, 2030));
      expect(source.ForId("utc").Id).toBe("UTC");
      expect(source.ForId("UTC").OriginalZone!.DisplayName).toBe("(UTC) Coordinated Universal Time");
      expect(() => source.ForId("Mars/Olympus_Mons")).toThrowNodaError("ArgumentException");
      // An IANA ID whose Windows zone isn't in this registry.
      expect(() => source.ForId("Europe/London")).toThrowNodaError("ArgumentException");
    });
  });

  it("converts Windows' rules into the same zone intervals as tzdb's, where they agree (including midnight transitions and Samoa)", () => {
    WithWindows(FakeZones, local(UtcZone), source => {
      expect(WeeklyOffsets(source.ForId("AUS Eastern Standard Time"), 2008, 2040)).toEqual(WeeklyOffsets(tzdb.Get("Australia/Sydney"), 2008, 2040));
      expect(WeeklyOffsets(source.ForId("E. South America Standard Time"), 2010, 2040)).toEqual(WeeklyOffsets(tzdb.Get("America/Sao_Paulo"), 2010, 2040));
      expect(WeeklyOffsets(source.ForId("Samoa Standard Time"), 2012, 2021)).toEqual(WeeklyOffsets(tzdb.Get("Pacific/Apia"), 2012, 2021));
      expect(WeeklyOffsets(source.ForId("Samoa Standard Time"), 2022, 2040)).toEqual(WeeklyOffsets(tzdb.Get("Pacific/Apia"), 2022, 2040));
      // Samoa's base offset changed (UTC-11 → UTC+13) at the end of 2011: a rule's own standard offset.
      const before = source.ForId("Samoa Standard Time").GetZoneInterval(Instant.FromUtc(2010, 7, 1, 0, 0));
      expect(before.StandardOffset.Equals(Offset.FromHours(-11))).toBe(true);
      // A transition at 24:00 (23:59:59.999 in Windows' data) is at midnight.
      const brazil = source.ForId("E. South America Standard Time").GetZoneInterval(Instant.FromUtc(2012, 6, 1, 0, 0));
      expect(brazil.Start.Equals(Instant.FromUtc(2012, 2, 26, 2, 0))).toBe(true);
      expect(brazil.End.Equals(Instant.FromUtc(2012, 10, 21, 3, 0))).toBe(true);
      // Names are the TimeZoneInfo's.
      const sydney = source.ForId("AUS Eastern Standard Time");
      expect(sydney.GetZoneInterval(Instant.FromUtc(2024, 1, 1, 0, 0)).Name).toBe("AUS Eastern Summer Time");
      expect(sydney.GetZoneInterval(Instant.FromUtc(2024, 7, 1, 0, 0)).Name).toBe("AUS Eastern Standard Time");
      expect(sydney.GetZoneInterval(Instant.MinValue).HasStart).toBe(false);
      expect(sydney.GetZoneInterval(Instant.MaxValue).HasEnd).toBe(false);
    });
  });

  it("reads names from the MUI files of the user's UI language or a parent, else from the registry", () => {
    const options = (languages: string[], files: NonNullable<FakeWindowsOptions["MuiFiles"]>): FakeWindowsOptions => ({ ...local(UtcZone), Languages: languages, MuiFiles: files });
    WithWindows(FakeZones, options(["fr-CA"], { "C:\\Windows\\system32\\fr\\tzres.dll.mui": { 670: "(UTC+10:00) Canberra, Melbourne, Sydney (fr)", 672: "Est de l'Australie" } }), source => {
      const sydney = source.ForId("AUS Eastern Standard Time");
      expect(sydney.DisplayName).toBe("(UTC+10:00) Canberra, Melbourne, Sydney (fr)");
      expect(sydney.OriginalZone!.StandardName).toBe("Est de l'Australie");
      // No string 671: the registry's Dlt.
      expect(sydney.OriginalZone!.DaylightName).toBe("AUS Eastern Summer Time");
      // Not English: UTC's standard name is localized too (from MUI_Std, -932: not in the file, so the registry's).
      expect(source.ForId("UTC").OriginalZone!.StandardName).toBe("Coordinated Universal Time");
    });
    WithWindows(FakeZones, options(["de-DE"], {}), source => {
      expect(source.ForId("AUS Eastern Standard Time").DisplayName).toBe("(UTC+10:00) Canberra, Melbourne, Sydney");
    });
  });

  it("the local zone: GetDynamicTimeZoneInformation's key name, or the matching registry entry, or 'Local'", () => {
    // DST turned off ("Adjust for daylight saving time automatically"): the same ID, but ForSystemDefault has no DST.
    WithWindows(FakeZones, local(AusEasternZone, { DynamicDaylightTimeDisabled: true }), source => {
      expect(source.GetSystemDefaultId()).toBe("AUS Eastern Standard Time");
      const zone = SystemDateTimeZone.ForSystemDefault();
      expect(zone.Id).toBe("AUS Eastern Standard Time");
      expect(zone.OriginalZone!.SupportsDaylightSavingTime).toBe(false);
      expect(zone.GetUtcOffset(Instant.FromUtc(2024, 1, 1, 0, 0)).Equals(Offset.FromHours(10))).toBe(true);
      expect(SystemDateTimeZone.ForSystemDefault()).toBe(zone);
      expect(new DateTimeZoneCache(source).GetSystemDefault().GetUtcOffset(Instant.FromUtc(2024, 1, 1, 0, 0)).Equals(Offset.FromHours(11))).toBe(true);
    });
    // No key name: found by comparing the data with the registry's.
    WithWindows(FakeZones, local(AusEasternZone, { KeyName: "" }), source => {
      expect(source.GetSystemDefaultId()).toBe("AUS Eastern Standard Time");
    });
    // A key that doesn't exist, and data that matches nothing: a zone built from the data, named by its standard name.
    const custom: FakeZone = { Id: "Nowhere", Std: "Nowhere Standard Time", Dlt: "Nowhere Daylight Time", Tzi: { Bias: -345 } };
    WithWindows(FakeZones, local(custom, { KeyName: "Nowhere" }), source => {
      expect(source.GetSystemDefaultId()).toBe("Nowhere Standard Time");
      expect(source.GetIds()).not.toContain("Nowhere Standard Time");
      expect(SystemDateTimeZone.ForSystemDefault().GetUtcOffset(Instant.FromUtc(2024, 1, 1, 0, 0)).Equals(Offset.FromHoursAndMinutes(5, 45))).toBe(true);
      expect(() => new DateTimeZoneCache(source).GetSystemDefault()).toThrow(DateTimeZoneNotFoundException);
    });
    // TIME_ZONE_ID_INVALID: a dummy UTC zone called "Local".
    WithWindows(FakeZones, { Local: null }, source => {
      expect(source.GetSystemDefaultId()).toBe("Local");
    });
  });

  it("caches TimeZoneInfo as .NET does: ForId returns zones over the same TimeZoneInfo", () => {
    WithWindows(FakeZones, local(UtcZone), (source, api) => {
      source.GetIds();
      const reads = api.Calls.get("GetRegistryValue");
      expect(source.ForId("AUS Eastern Standard Time").OriginalZone).toBe(source.ForId("AUS Eastern Standard Time").OriginalZone);
      expect(api.Calls.get("GetRegistryValue")).toBe(reads);
    });
  });
});

// How the TZ environment variable is resolved. (Reading it, and GetSystemDefault / ForSystemDefault with it set, are
// checked in processes started with it: environment.test.ts. Setting it here would change the test process's zone.)
describe("resolving the TZ environment variable", () => {
  it("with TimeZoneInfo, TimeZoneInfo.Local is the zone TZ names (read when Local is first used): a Windows ID, an IANA ID, or UTC for anything else", () => {
    const localWith = (tz: string | undefined): [string, string | null, string] => {
      SetTZ(tz);
      return WithWindows(FakeZones, local(SaWesternZone), source =>
        [TimeZoneInfoInterceptor.Local!.Id, source.GetSystemDefaultId(), SystemDateTimeZone.ForSystemDefault().Id]);
    };
    expect(localWith(undefined)).toEqual(["SA Western Standard Time", "SA Western Standard Time", "SA Western Standard Time"]);
    expect(localWith("")).toEqual(["SA Western Standard Time", "SA Western Standard Time", "SA Western Standard Time"]);
    expect(localWith(":AUS Eastern Standard Time")).toEqual(["AUS Eastern Standard Time", "AUS Eastern Standard Time", "AUS Eastern Standard Time"]);
    expect(localWith("AUS Eastern Standard Time")).toEqual(["AUS Eastern Standard Time", "AUS Eastern Standard Time", "AUS Eastern Standard Time"]);
    expect(localWith("Australia/Sydney")).toEqual(["AUS Eastern Standard Time", "AUS Eastern Standard Time", "AUS Eastern Standard Time"]);
    expect(localWith("Mars/Olympus_Mons")).toEqual(["UTC", "UTC", "UTC"]);
  });

  it("a replaced TimeZoneInfo.Local (NodaTime's TimeZoneInfoReplacer) wins over TZ, as TZ only decides what Local is", () => {
    SetTZ("AUS Eastern Standard Time");
    WithWindows(FakeZones, local(SaWesternZone), () => {
      const shim = TimeZoneInfoInterceptor.Shim!;
      const samoa = shim.FindSystemTimeZoneById("Samoa Standard Time");
      const restore = TimeZoneInfoReplacer.Replace(samoa, ...shim.GetSystemTimeZones());
      try {
        SystemDateTimeZone.ResetSystemDefaultCache();
        // A source created after the replacement, as in NodaTime's tests.
        expect(new SystemDateTimeZoneSource().GetSystemDefaultId()).toBe("Samoa Standard Time");
        expect(SystemDateTimeZone.ForSystemDefault().Id).toBe("Samoa Standard Time");
      } finally {
        restore();
      }
    });
  });

  const resolve = (tz: string): string | null => WithWindows(FakeZones, local(UtcZone), () => ResolveTimeZoneInfoId(TimeZoneInfoInterceptor.Shim!, tz));

  it("with TimeZoneInfo: a Windows ID (any case), or an IANA ID mapped to its Windows ID", () => {
    expect(resolve("AUS Eastern Standard Time")).toBe("AUS Eastern Standard Time");
    expect(resolve("aus eastern standard time")).toBe("AUS Eastern Standard Time");
    expect(resolve("Australia/Sydney")).toBe("AUS Eastern Standard Time");
    expect(resolve("Australia/Melbourne")).toBe("AUS Eastern Standard Time");
    expect(resolve("America/La_Paz")).toBe("SA Western Standard Time");
    expect(resolve("UTC")).toBe("UTC");
    expect(resolve("Etc/UTC")).toBe("UTC");
  });

  it("with TimeZoneInfo: anything else names no zone (and so means UTC: see environment.test.ts)", () => {
    expect(resolve("Mars/Olympus_Mons")).toBeNull();
    // An IANA ID whose Windows zone isn't in the registry.
    expect(resolve("Europe/London")).toBeNull();
    // A POSIX TZ string.
    expect(resolve("AEST-10AEDT,M10.1.0,M4.1.0/3")).toBeNull();
  });

  it("the tzdb source: a Windows ID mapped by its WindowsMapping, a tzdb ID as is, anything else is Etc/UTC (no guess)", () => {
    const source = TzdbDateTimeZoneSource.FromBytes(tzdbSourceBytes());
    const fromTz = (id: string): string | null => source.MapTimeZoneInfoId({ Id: id, FromEnvironment: true, GetUtcOffset: () => Offset.Zero });
    expect(fromTz("SA Western Standard Time")).toBe("America/La_Paz");
    expect(fromTz("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(fromTz("Mars/Olympus_Mons")).toBe("Etc/UTC");
    expect(fromTz("UTC")).toBe("Etc/UTC");
  });
});

describe.runIf(typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function")("without TimeZoneInfo: the host's Intl zones", () => {
  it("on Windows: Windows IDs mapped by CLDR, with the rules of their primary IANA zone; IANA IDs accepted too", () => {
    const intl = new IntlSystemTimeZones(true);
    const source = SystemDateTimeZoneSource.NewIntl(intl);
    expect(source.Backend).toBe("intl");
    expect(source.VersionId).toMatch(/^Intl: .+ \(Windows IDs from CLDR windowsZones \d+\)$/);
    const ids = source.GetIds();
    expect(ids).toContain("AUS Eastern Standard Time");
    expect(ids).toContain("UTC");
    expect(ids).not.toContain("Australia/Sydney");
    const zone = source.ForId("aus eastern standard time");
    expect(zone.Id).toBe("AUS Eastern Standard Time");
    expect(zone.OriginalZone).toBeNull();
    expect(WeeklyOffsets(zone, 2000, 2030)).toEqual(WeeklyOffsets(tzdb.Get("Australia/Sydney"), 2000, 2030));
    expect(source.ForId("Australia/Sydney").Id).toBe("Australia/Sydney");
    expect(() => source.ForId("Mars/Olympus_Mons")).toThrowNodaError("ArgumentException");
    expect(intl.ResolveId("America/La_Paz")).toBe("SA Western Standard Time");
    expect(intl.ResolveId("sa western standard time")).toBe("SA Western Standard Time");
    expect(intl.ResolveId("Mars/Olympus_Mons")).toBeNull();
  });

  it("elsewhere: IANA IDs", () => {
    const intl = new IntlSystemTimeZones(false);
    const source = SystemDateTimeZoneSource.NewIntl(intl);
    expect(source.VersionId).toMatch(/^Intl: [^(]+$/);
    expect(source.GetIds()).toContain("Australia/Sydney");
    expect(source.GetIds()).not.toContain("AUS Eastern Standard Time");
    const zone = source.ForId("Australia/Sydney");
    expect(WeeklyOffsets(zone, 2000, 2030)).toEqual(WeeklyOffsets(tzdb.Get("Australia/Sydney"), 2000, 2030));
    expect(() => source.ForId("AUS Eastern Standard Time")).toThrowNodaError("ArgumentException");
    expect(intl.ResolveId("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(intl.ResolveId("AUS Eastern Standard Time")).toBeNull();
    const provider: IDateTimeZoneProvider = new DateTimeZoneCache(source);
    expect(provider.GetSystemDefault()).toBeInstanceOf(SystemDateTimeZone);
  });

  it("SystemDateTimeZone.ForSystemDefault and the provider agree", () => {
    WithShim(null, () => {
      const source = new SystemDateTimeZoneSource();
      expect(source.Backend).toBe("intl");
      expect(SystemDateTimeZone.ForSystemDefault().Id).toBe(new DateTimeZoneCache(source).GetSystemDefault().Id);
    });
  });
});

describe("the tzdb source's guess of the host's zone (GuessZoneIdByTransitionsUncached)", () => {
  let candidates: DateTimeZone[];
  beforeAll(() => {
    candidates = [...new Set(tzdbSource.CanonicalIdMap.values())].map(id => tzdbSource.ForId(id)).sort((a, b) => (a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0));
  });

  const like = (zone: DateTimeZone, id = "Local"): IHostTimeZone => ({ Id: id, FromEnvironment: false, GetUtcOffset: instant => zone.GetUtcOffset(instant) });

  it("picks the first zone (in ordinal order) with the host zone's offsets", () => {
    const tokyo = tzdb.Get("Asia/Tokyo");
    const guess = TzdbDateTimeZoneSource.GuessZoneIdByTransitionsUncached(like(tokyo), candidates);
    // The first of the zones that are UTC+9 for the next five years (Asia/Chita, Asia/Dili, ..., Asia/Tokyo, ...).
    const thisYear = SystemClock.Instance.GetCurrentInstant().InUtc().Year;
    const expected = candidates.find(zone => WeeklyOffsets(zone, thisYear, thisYear + 5).every(offset => offset === 32400));
    expect(guess).toBe(expected!.Id);
    // Antarctica/Macquarie has had Sydney's rules since 2010.
    expect(TzdbDateTimeZoneSource.GuessZoneIdByTransitionsUncached(like(tzdb.Get("Australia/Sydney")), candidates)).toBe("Antarctica/Macquarie");
  });

  it("returns null when no zone matches 70% of the transitions", () => {
    const strange: IHostTimeZone = { Id: "Strange", FromEnvironment: false, GetUtcOffset: () => Offset.FromHoursAndMinutes(13, 37) };
    expect(TzdbDateTimeZoneSource.GuessZoneIdByTransitionsUncached(strange, candidates)).toBeNull();
  });

  it("MapTimeZoneInfoId: a Windows ID, a tzdb ID, a guess; a TZ ID that doesn't map is UTC", () => {
    const source = TzdbDateTimeZoneSource.FromBytes(tzdbSourceBytes());
    expect(source.MapTimeZoneInfoId(like(tzdb.Get("Asia/Tokyo"), "Tokyo Standard Time"))).toBe("Asia/Tokyo");
    expect(source.MapTimeZoneInfoId(like(tzdb.Get("Asia/Tokyo"), "Asia/Tokyo"))).toBe("Asia/Tokyo");
    expect(source.MapTimeZoneInfoId(like(DateTimeZone.ForOffset(Offset.FromHours(-10)), "Lilo and Stitch"))).toBe("Etc/GMT+10");
    expect(source.MapTimeZoneInfoId({ ...like(tzdb.Get("Asia/Tokyo"), "Not A Zone"), FromEnvironment: true })).toBe("Etc/UTC");
  });

  it("the host's zone has Date's offsets", () => {
    const host = GetHostTimeZone();
    const instant = Instant.FromUtc(2024, 1, 15, 12, 0);
    expect(host.GetUtcOffset(instant).Seconds).toBe(-new Date(instant.ToUnixTimeMilliseconds()).getTimezoneOffset() * 60);
  });
});

/** A fresh source's bytes (so its guess cache is empty). */
function tzdbSourceBytes(): Uint8Array {
  return DecodeBase64(nzdBase64);
}
