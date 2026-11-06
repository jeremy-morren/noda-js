// noda-js/system on Windows (node:ffi) compared exactly with NodaTime's BclDateTimeZoneSource on .NET, on this machine:
// every zone's ID, names, rules and zone intervals, the IDs (in order), the system default and the local zone, as
// exported by tools/NodaJs.Tools (system-zones) into test-results/system-zones.json. Run
// `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/export-system-zones.ps1` first.
//
// Skipped where it can't run: outside Node, not on Windows, without node:ffi, or without the export. (Node only:
// node:fs and Windows; vitest.config.ts's nodeOnly list is for whole files, so it loads node:fs dynamically.)

import { describe, expect, it } from "vitest";
import { Instant, SystemDateTimeZone, SystemDateTimeZoneSource, ZoneInterval } from "../../src/noda-js/internal.ts";
import { TryConvertIanaIdToWindowsId } from "../../src/noda-js/System/WindowsIdMapping.ts";
import type { TimeZoneInfoTransitionTime } from "../../src/noda-js/System/TimeZoneInfo.TransitionTime.ts";

interface ExportedZone {
  readonly id: string;
  readonly displayName: string;
  readonly standardName: string;
  readonly daylightName: string;
  readonly baseUtcOffsetMinutes: number;
  readonly supportsDaylightSavingTime: boolean;
  readonly minOffsetSeconds: number;
  readonly maxOffsetSeconds: number;
  readonly rules: readonly unknown[];
  readonly intervals: readonly unknown[];
}

interface Export {
  readonly generator: string;
  readonly startYear: number;
  readonly endYear: number;
  readonly versionId: string;
  readonly systemDefaultId: string | null;
  readonly local: ExportedZone;
  readonly ids: readonly string[];
  readonly zones: readonly ExportedZone[];
  readonly ianaToWindows: Readonly<Record<string, string>>;
}

declare const process: { platform: string; env: Record<string, string | undefined> } | undefined;

// The module specifier in a variable, so that Vite doesn't try to resolve it for the browser projects.
const fsModule = "node:fs";

async function LoadExport(): Promise<Export | null> {
  if (typeof window !== "undefined" || typeof process === "undefined" || process.platform !== "win32") {
    return null;
  }
  const { existsSync, readFileSync } = (await import(/* @vite-ignore */ fsModule)) as typeof import("node:fs");
  const path = new URL("../../test-results/system-zones.json", import.meta.url);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Export) : null;
}

const exported = await LoadExport();
// The comparison is with the host's own zone and Windows' data through node:ffi (with TZ set, the default differs).
const source = exported === null ? null : new SystemDateTimeZoneSource();
const comparable = exported !== null && source!.Backend !== "intl";

function DescribeInterval(interval: ZoneInterval): unknown[] {
  return [
    interval.HasStart ? interval.Start.ToUnixTimeMilliseconds() : null,
    interval.HasEnd ? interval.End.ToUnixTimeMilliseconds() : null,
    interval.WallOffset.Seconds,
    interval.Savings.Seconds,
    interval.Name,
  ];
}

function DescribeTransition(transition: TimeZoneInfoTransitionTime): number[] {
  return [transition.IsFixedDateRule ? 1 : 0, transition.Month, transition.Week, transition.Day, transition.DayOfWeek, transition.TimeOfDay.TickOfDay / 10_000];
}

function DescribeZone(zone: SystemDateTimeZone, startYear: number, endYear: number): ExportedZone {
  const info = zone.OriginalZone!;
  const minutes = (ticks: number): number => ticks / 600_000_000;
  return {
    id: zone.Id,
    displayName: zone.DisplayName,
    standardName: info.StandardName,
    daylightName: info.DaylightName,
    baseUtcOffsetMinutes: minutes(info.BaseUtcOffset),
    supportsDaylightSavingTime: info.SupportsDaylightSavingTime,
    minOffsetSeconds: zone.MinOffset.Seconds,
    maxOffsetSeconds: zone.MaxOffset.Seconds,
    rules: info.GetAdjustmentRules().map(rule => ({
      dateStart: rule.DateStart.toString(),
      dateEnd: rule.DateEnd.toString(),
      daylightDeltaMinutes: minutes(rule.DaylightDelta),
      baseUtcOffsetDeltaMinutes: minutes(rule.BaseUtcOffsetDelta),
      start: DescribeTransition(rule.DaylightTransitionStart),
      end: DescribeTransition(rule.DaylightTransitionEnd),
    })),
    intervals: [...zone.GetZoneIntervals(Instant.FromUtc(startYear, 1, 1, 0, 0), Instant.FromUtc(endYear, 1, 1, 0, 0))].map(DescribeInterval),
  };
}

/**
 * IANA IDs that CLDR's windowsZones release noda-js bundles maps differently from the ICU .NET uses (the tools run with
 * app-local ICU 72.1, whose CLDR is older): newer Windows zones for Canadian provinces, Mexico and Kazakhstan, and the
 * POSIX-style IDs CLDR has since dropped. Each is CLDR's own mapping, which noda-js uses on every host.
 */
const CldrChanges = new Set([
  "America/Chihuahua", "America/Edmonton", "America/Inuvik", "America/Ojinaga", "America/Rainy_River", "America/Vancouver",
  "America/Winnipeg", "America/Yellowknife", "Asia/Almaty", "Asia/Qostanay", "Canada/Central", "Canada/Mountain", "Canada/Pacific",
  "CST6CDT", "EST5EDT", "MST7MDT", "PST8PDT",
]);

describe.skipIf(!comparable)("noda-js/system matches NodaTime's BclDateTimeZoneSource on .NET (test-results/system-zones.json)", () => {
  it("the same IDs, in the same order, and the same system default", () => {
    expect(source!.GetIds()).toEqual(exported!.ids);
    if (process!.env["TZ"] === undefined || process!.env["TZ"] === "") {
      expect(source!.GetSystemDefaultId()).toBe(exported!.systemDefaultId);
    }
  });

  it("the same local zone (BclDateTimeZone.ForSystemDefault)", () => {
    if (process!.env["TZ"] !== undefined && process!.env["TZ"] !== "") {
      return;
    }
    expect(DescribeZone(SystemDateTimeZone.ForSystemDefault(), exported!.startYear, exported!.endYear)).toEqual(exported!.local);
  });

  it.each(exported?.zones.map(zone => [zone.id, zone] as const) ?? [])("%s: the same names, rules and zone intervals", (id, expected) => {
    expect(DescribeZone(source!.ForId(id), exported!.startYear, exported!.endYear)).toEqual(expected);
  });

  it("IANA IDs map to the same Windows IDs, except where CLDR has changed since the ICU .NET uses", () => {
    const differences: string[] = [];
    for (const ianaId of Object.keys(exported!.ianaToWindows)) {
      const ours = TryConvertIanaIdToWindowsId(ianaId);
      if (ours !== exported!.ianaToWindows[ianaId] && !CldrChanges.has(ianaId)) {
        differences.push(`${ianaId}: ${ours} (noda-js) vs ${exported!.ianaToWindows[ianaId]} (.NET)`);
      }
    }
    expect(differences).toEqual([]);
    // ForId accepts them, keeping the IANA ID, with the Windows zone's rules.
    const sydney = source!.ForId("Australia/Sydney");
    expect(sydney.Id).toBe("Australia/Sydney");
    expect(sydney.GetZoneInterval(Instant.FromUtc(2024, 1, 1, 0, 0)).Name).toBe(source!.ForId("AUS Eastern Standard Time").GetZoneInterval(Instant.FromUtc(2024, 1, 1, 0, 0)).Name);
  });
});

describe.skipIf(comparable)("noda-js/system compared with .NET", () => {
  it.skip("needs Windows, Node with node:ffi and test-results/system-zones.json (scripts/export-system-zones.ps1)", () => {});
});
