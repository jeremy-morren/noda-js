// noda-js: new code. Conversions between Windows time zone IDs and IANA IDs with CLDR's windowsZones.xml (the copy
// bundled with noda-js/windows), standing in for the ICU calls .NET makes for TimeZoneInfo.TryConvertIanaIdToWindowsId
// and TryConvertWindowsIdToIanaId.

import { MapZone } from "../internal.ts";
import { GetCldrWindowsZones } from "../Bcl/CldrWindowsZones.ts";
import { IntlCanonicalTimeZoneId } from "./IntlTimeZone.ts";

let ianaToWindows: Map<string, string> | undefined;
let canonicalIanaToWindows: Map<string, string> | undefined;

/** Every IANA ID in CLDR's mapping (any territory) → its Windows ID. */
function GetIanaToWindows(): Map<string, string> {
  if (ianaToWindows === undefined) {
    ianaToWindows = new Map<string, string>();
    for (const mapZone of GetCldrWindowsZones().MapZones) {
      for (const tzdbId of mapZone.TzdbIds) {
        if (!ianaToWindows.has(tzdbId)) {
          ianaToWindows.set(tzdbId, mapZone.WindowsId);
        }
      }
    }
  }
  return ianaToWindows;
}

/**
 * The Windows ID CLDR maps an IANA ID to, as ICU's ucal_getWindowsTimeZoneID does for .NET: the ID is first
 * canonicalized (with the host's Intl, where available, so aliases such as "Asia/Kolkata" or "US/Pacific" map too),
 * then looked up in every territory's mapping. Null if there's no mapping.
 * @internal
 */
export function TryConvertIanaIdToWindowsId(ianaId: string): string | null {
  const direct = GetIanaToWindows().get(ianaId);
  if (direct !== undefined) {
    return direct;
  }
  const canonical = IntlCanonicalTimeZoneId(ianaId);
  if (canonical === null) {
    return null;
  }
  if (canonicalIanaToWindows === undefined) {
    canonicalIanaToWindows = new Map<string, string>();
    GetIanaToWindows().forEach((windowsId, tzdbId) => {
      const key = IntlCanonicalTimeZoneId(tzdbId);
      if (key !== null && !canonicalIanaToWindows!.has(key)) {
        canonicalIanaToWindows!.set(key, windowsId);
      }
    });
  }
  return canonicalIanaToWindows.get(canonical) ?? null;
}

/**
 * The IANA ID CLDR maps a Windows ID to for the "001" territory (as TimeZoneInfo.TryConvertWindowsIdToIanaId does
 * with no region), or null. Windows IDs match case-insensitively, as Windows' registry keys do.
 * @internal
 */
export function TryConvertWindowsIdToIanaId(windowsId: string): { readonly WindowsId: string; readonly IanaId: string } | null {
  const upper = windowsId.toUpperCase();
  for (const mapZone of GetCldrWindowsZones().MapZones) {
    if (mapZone.Territory === MapZone.PrimaryTerritory && mapZone.WindowsId.toUpperCase() === upper) {
      return { WindowsId: mapZone.WindowsId, IanaId: mapZone.TzdbIds[0]! };
    }
  }
  return null;
}

/** The Windows IDs with a primary ("001") mapping, in CLDR's order. @internal */
export function GetMappedWindowsIds(): readonly string[] {
  const ids: string[] = [];
  for (const mapZone of GetCldrWindowsZones().MapZones) {
    if (mapZone.Territory === MapZone.PrimaryTerritory) {
      ids.push(mapZone.WindowsId);
    }
  }
  return ids;
}

/** The version of the CLDR mapping. @internal */
export function GetWindowsIdMappingVersion(): string {
  return GetCldrWindowsZones().Version;
}
