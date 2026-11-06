// noda-js on a host without the web APIs it can use: no Intl, navigator, TextDecoder, atob, Uint8Array.fromBase64 or
// performance (as in embedded or scripting JavaScript engines). The library is loaded fresh with those globals
// removed, so nothing it caches at load time comes from a full environment. Everything that doesn't need the host's
// time zones or languages must work; what does must fail with a clear error. (performance is removed only around
// the clock test, which is the only code that reads it, and only when called: Vitest's runner needs it between
// tests.) The tzdb compiler (noda-js/tzdb/compiler) also runs without DecompressionStream, TextEncoder and fetch, which
// are removed around its test (and XMLHttpRequest, which Node doesn't have).
// (Node only: it removes globals and re-imports the modules; see vitest.config.ts.)

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Core = typeof import("../src/noda-js/index.ts");

let noda: Core;
let tzdb: typeof import("../src/noda-js/entries/tzdb-bundled.ts").tzdb;
let system: typeof import("../src/noda-js/entries/system.ts");
let internal: typeof import("../src/noda-js/internal.ts");
let cultures: typeof import("../src/noda-js/Cultures/index.generated.ts");
let compiler: typeof import("../src/noda-js/entries/tzdb-compiler.ts");
let fromBase64: PropertyDescriptor | undefined;
const now = Date.now();

beforeAll(async () => {
  for (const name of ["Intl", "navigator", "TextDecoder", "atob"]) {
    vi.stubGlobal(name, undefined);
  }
  fromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
  if (fromBase64 !== undefined) {
    delete (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64;
  }
  vi.resetModules();
  noda = await import("../src/noda-js/index.ts");
  ({ tzdb } = await import("../src/noda-js/entries/tzdb-bundled.ts"));
  system = await import("../src/noda-js/entries/system.ts");
  internal = await import("../src/noda-js/internal.ts");
  cultures = await import("../src/noda-js/Cultures/index.generated.ts");
  compiler = await import("../src/noda-js/entries/tzdb-compiler.ts");
  // Re-importing (and transforming) the whole library takes seconds, more when the full suite runs alongside.
}, 120_000);

afterAll(() => {
  vi.unstubAllGlobals();
  if (fromBase64 !== undefined) {
    Object.defineProperty(Uint8Array, "fromBase64", fromBase64);
  }
  vi.resetModules();
});

describe("without Intl, navigator, TextDecoder, atob, Uint8Array.fromBase64 or performance", () => {
  it("really has none of them", () => {
    expect(typeof Intl).toBe("undefined");
    expect(typeof navigator).toBe("undefined");
    expect(typeof TextDecoder).toBe("undefined");
    expect(typeof atob).toBe("undefined");
    expect("fromBase64" in Uint8Array).toBe(false);
  });

  it("loads the bundled tzdb and converts between zones", () => {
    const instant = noda.Instant.FromUtc(2024, 7, 1, 12, 0);
    expect(instant.InZone(tzdb.Get("Europe/Madrid")).toString()).toBe("2024-07-01T14:00:00 Europe/Madrid (+02)");
    expect(instant.InZone(tzdb.Get("Australia/Sydney")).toString()).toBe("2024-07-01T22:00:00 Australia/Sydney (+10)");
    expect(tzdb.Ids.length).toBeGreaterThan(500);
  });

  it("formats and parses, in the invariant culture and others (names match case-insensitively)", () => {
    const date = new noda.LocalDate(2024, 7, 1);
    expect(date.toString("d MMMM uuuu", null)).toBe("1 July 2024");
    const spanish = noda.LocalDatePattern.Create("d 'de' MMMM 'de' uuuu", cultures.esES);
    expect(spanish.Format(date)).toBe("1 de julio de 2024");
    // Month names match case-insensitively (quoted literals such as 'de' match exactly, as in NodaTime).
    expect(spanish.Parse("1 de JULIO de 2024").Value.Equals(date)).toBe(true);
  });

  it("reads and writes JSON", () => {
    const zoned = noda.Instant.FromUtc(2024, 7, 1, 12, 0).InZone(tzdb.Get("Europe/Madrid"));
    const json = zoned.toJSON();
    expect(json).toBe("2024-07-01T14:00:00+02 Europe/Madrid");
    expect(noda.ZonedDateTime.fromJSON(json, tzdb).Equals(zoned)).toBe(true);
    expect(noda.Period.fromJSON("P1Y2M3DT4H").toString()).toBe("P1Y2M3DT4H");
  });

  it("reads the system clock from Date.now(), without performance", () => {
    const hostPerformance = globalThis.performance;
    vi.stubGlobal("performance", undefined);
    let current: number;
    try {
      expect(typeof performance).toBe("undefined");
      current = noda.SystemClock.Instance.GetCurrentInstant().ToUnixTimeMilliseconds();
    } finally {
      vi.stubGlobal("performance", hostPerformance);
    }
    expect(current).toBeGreaterThanOrEqual(now);
    expect(current).toBeLessThan(now + 60_000);
  });

  it("CurrentCulture throws a clear error: the host reports no languages", () => {
    expect(() => noda.NodaCultureInfo.CurrentCulture).toThrowNodaError("InvalidOperationException");
    expect(() => noda.NodaCultureInfo.CurrentCulture).toThrow(/The host reports no languages/);
  });

  it("the tzdb provider can't name the system's zone, so it guesses it from Date's offsets (GuessZoneIdByTransitions)", () => {
    // (Unless TZ names it.)
    const zone = tzdb.GetSystemDefault();
    for (const month of [0, 6]) {
      const instant = noda.Instant.FromUtc(new Date(now).getUTCFullYear(), month + 1, 15, 12, 0);
      // 0 - x, not -x: in UTC, getTimezoneOffset() is 0, and -0 isn't +0 to toBe.
      expect(zone.GetUtcOffset(instant).Seconds).toBe(0 - new Date(instant.ToUnixTimeMilliseconds()).getTimezoneOffset() * 60);
    }
  });

  it("noda-js/system says it needs Intl, on first use, unless it can read Windows' zones (Windows, with node:ffi)", () => {
    if (internal.TimeZoneInfoInterceptor.Shim === null) {
      expect(() => system.SystemDateTimeZoneProvider.Ids).toThrowNodaError("InvalidOperationException");
      expect(() => system.SystemDateTimeZoneProvider.Ids).toThrow(/needs the host's Intl/);
    } else {
      expect(new system.SystemDateTimeZoneSource().Backend).not.toBe("intl");
      expect(system.SystemDateTimeZoneProvider.Get("AUS Eastern Standard Time").GetUtcOffset(noda.Instant.FromUtc(2024, 7, 1, 0, 0)).Seconds).toBe(36000);
    }
  });

  it("noda-js/tzdb/compiler compiles a .tar.gz without DecompressionStream, TextEncoder, fetch or XMLHttpRequest (a URL needs one of them)", async () => {
    const archive = new Uint8Array(readFileSync(new URL("./fixtures/tzdb/tzdata2026f.tar.gz", import.meta.url)));
    const names = ["DecompressionStream", "TextEncoder", "fetch"];
    const saved = names.map(name => (globalThis as Record<string, unknown>)[name]);
    names.forEach(name => vi.stubGlobal(name, undefined));
    try {
      const source = await compiler.CompileTzdb(archive);
      expect(source.VersionId).toBe(tzdb.VersionId);
      const madrid = new noda.DateTimeZoneCache(source).Get("Europe/Madrid");
      expect(noda.Instant.FromUtc(2024, 7, 1, 12, 0).InZone(madrid).toString()).toBe("2024-07-01T14:00:00 Europe/Madrid (+02)");
      await expect(compiler.CompileTzdb("https://data.iana.org/time-zones/tzdata-latest.tar.gz")).rejects.toThrowNodaError("InvalidOperationException");
      // Nor XMLHttpRequest (Node has none), which the synchronous variant downloads a URL with.
      expect(typeof XMLHttpRequest).toBe("undefined");
      expect(() => compiler.CompileTzdbSync("https://data.iana.org/time-zones/tzdata-latest.tar.gz")).toThrowNodaError("InvalidOperationException");
    } finally {
      names.forEach((name, i) => vi.stubGlobal(name, saved[i]));
    }
  }, 60_000);
});
