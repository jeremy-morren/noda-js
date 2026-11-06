// noda-js: new code. TimeZoneInfo.Local from the TZ environment variable. .NET honours TZ on Unix (TimeZoneInfo.Unix's
// GetLocalTimeZoneCore) but not on Windows; noda-js honours it on Windows too, and accepts Windows IDs there as well as
// IANA IDs (see docs/Timezones.md). TimeZoneInfoCachedData.CreateLocal (TimeZoneInfo.Win32.ts) calls this before it
// asks Windows, so TimeZoneInfo.Local, and everything that uses it (the system source's default, ForSystemDefault, and
// NodaTime's TimeZoneInfoReplacer in the tests), sees one zone, read once per process as .NET reads it.

import { IsNodaError } from "../internal.ts";
import { GetTZEnvironmentVariable } from "../Utility/TimeZoneEnvironment.ts";
import type { TimeZoneInfo } from "./TimeZoneInfo.ts";
import { TryConvertIanaIdToWindowsId } from "./WindowsIdMapping.ts";

/** The parts of TimeZoneInfo's static API (TimeZoneInfoCachedData) ResolveTimeZoneInfoId uses. @internal */
export interface ISystemTimeZoneLookup {
  GetSystemTimeZones(): readonly TimeZoneInfo[];
  FindSystemTimeZoneById(id: string): TimeZoneInfo;
}

/**
 * The local zone the TZ environment variable names, or null if it isn't set. A TZ that names no zone means UTC (the
 * registry's "UTC" zone, else TimeZoneInfo.Utc), as it does for Node, Python, glibc and .NET on Unix.
 * @internal
 */
export function GetLocalTimeZoneFromTZ(lookup: ISystemTimeZoneLookup & { readonly Utc: TimeZoneInfo }): TimeZoneInfo | null {
  const tz = GetTZEnvironmentVariable();
  if (tz === null) {
    return null;
  }
  const id = ResolveTimeZoneInfoId(lookup, tz) ?? ResolveTimeZoneInfoId(lookup, "UTC");
  return id === null ? lookup.Utc : lookup.FindSystemTimeZoneById(id);
}

/**
 * The ID of the system zone an ID (such as the TZ environment variable's) names: a Windows ID in the registry's case,
 * or the Windows ID an IANA ID maps to (as FindSystemTimeZoneById maps it); null if there's none.
 * @internal
 */
export function ResolveTimeZoneInfoId(lookup: ISystemTimeZoneLookup, id: string): string | null {
  try {
    // Read every zone first, so that a Windows ID matched case-insensitively comes back in the registry's case.
    lookup.GetSystemTimeZones();
    const zone = lookup.FindSystemTimeZoneById(id);
    if (!zone.HasIanaId || zone.Id.toUpperCase() === "UTC") {
      return zone.Id;
    }
    // An IANA ID: the zone keeps it as its ID, but the system zone's ID is the Windows one it maps to.
    const windowsId = TryConvertIanaIdToWindowsId(id);
    return windowsId === null ? null : lookup.FindSystemTimeZoneById(windowsId).Id;
  } catch (e) {
    if (IsNodaError(e, "TimeZoneNotFoundException") || IsNodaError(e, "InvalidTimeZoneException")) {
      return null;
    }
    throw e;
  }
}
