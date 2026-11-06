// noda-js: new code. noda-js/system's time zones where the host can't read Windows' time zone data: the host's Intl
// zones. On a Windows runtime (Node, Bun or Deno without FFI or the native addon), they're given Windows IDs through
// CLDR's mapping, as .NET on Windows names them; elsewhere (browsers on any OS, as .NET in a browser; other operating
// systems) they have IANA IDs.

import { NewInvalidOperationException, SystemDateTimeZone } from "../internal.ts";
import type { InvalidOperationException } from "../internal.ts";
import { IsWindowsRuntime } from "./Host.ts";
import { GetIntlLocalId, GetIntlSupportedTimeZones, GetIntlTimeZoneVersion, IntlCanonicalTimeZoneId, IsIntlAvailable, IsIntlTimeZoneId } from "./IntlTimeZone.ts";
import { GetTZEnvironmentVariable } from "../Utility/TimeZoneEnvironment.ts";
import { GetMappedWindowsIds, GetWindowsIdMappingVersion, TryConvertIanaIdToWindowsId, TryConvertWindowsIdToIanaId } from "./WindowsIdMapping.ts";

let forHost: IntlSystemTimeZones | undefined;

/**
 * The host's Intl time zones, with Windows or IANA IDs.
 * @internal
 */
export class IntlSystemTimeZones {
  private _windowsIds: readonly string[] | undefined;
  private _systemDefault: SystemDateTimeZone | null = null;

  /**
   * @param UseWindowsIds Whether zones have Windows IDs (mapped from the host's IANA zones with CLDR's mapping).
   * @throws {InvalidOperationException} The host has no Intl.DateTimeFormat.
   */
  constructor(readonly UseWindowsIds: boolean) {
    if (!IsIntlAvailable()) {
      throw NewInvalidOperationException(
        "noda-js/system needs the host's Intl.DateTimeFormat (with time zone support) where it can't read Windows' time zones, " +
          "and it isn't available. Use the bundled tzdb (noda-js/tzdb/bundled) instead.",
      );
    }
  }

  /**
   * The zones for this host: Windows IDs on a Windows runtime, IANA IDs elsewhere.
   * @throws {InvalidOperationException} The host has no Intl.DateTimeFormat.
   */
  static ForHost(): IntlSystemTimeZones {
    return (forHost ??= new IntlSystemTimeZones(IsWindowsRuntime()));
  }

  /** "Intl: <tz version>", e.g. "Intl: 2025b", plus the CLDR mapping's version where IDs are Windows IDs. */
  get VersionId(): string {
    const version = `Intl: ${GetIntlTimeZoneVersion()}`;
    return this.UseWindowsIds ? `${version} (Windows IDs from CLDR windowsZones ${GetWindowsIdMappingVersion()})` : version;
  }

  /**
   * The IDs: with Windows IDs, those CLDR maps (for its "001" territory) to a zone the host supports; otherwise
   * Intl.supportedValuesOf("timeZone"). Either way, plus the host's default zone's ID if that isn't one of them (as
   * hosts typically don't list "UTC", or an IANA zone CLDR doesn't map).
   */
  GetIds(): readonly string[] {
    const ids = new Set<string>(this.UseWindowsIds ? this.GetWindowsIds() : GetSupportedIds());
    const local = this.GetSystemDefaultId();
    if (local !== null && this.ForId(local) !== null) {
      ids.add(local);
    }
    return [...ids];
  }

  /**
   * The zone with the given ID, or null if there isn't one. With Windows IDs, a Windows ID matches case-insensitively
   * (the zone has its canonical case) and is the host's zone for CLDR's primary IANA zone; an IANA ID that CLDR maps to a
   * Windows ID (as .NET 6+ accepts them on Windows), or the host's default zone's ID, is the host's zone and keeps the
   * ID it was asked for. Otherwise, any ID the host's Intl accepts.
   */
  ForId(id: string): SystemDateTimeZone | null {
    if (!this.UseWindowsIds) {
      return IsIntlTimeZoneId(id) ? SystemDateTimeZone.FromIntl(id, id) : null;
    }
    const windows = TryConvertWindowsIdToIanaId(id);
    if (windows !== null && this.GetWindowsIds().indexOf(windows.WindowsId) !== -1) {
      return SystemDateTimeZone.FromIntl(windows.WindowsId, windows.IanaId);
    }
    if (IsIntlTimeZoneId(id) && (TryConvertIanaIdToWindowsId(id) !== null || id === this.GetSystemDefaultId())) {
      return SystemDateTimeZone.FromIntl(id, id);
    }
    return null;
  }

  /**
   * The ID of the current zone: the TZ environment variable's, if it's set (resolved as {@link IntlSystemTimeZones.ResolveId}
   * does; UTC's, "UTC" with Windows IDs and "Etc/UTC" otherwise, if it names no zone), otherwise the host's default zone's: with Windows IDs, the Windows ID CLDR maps it
   * to (or its IANA ID, if there's none); otherwise its IANA ID. Null if there's no default zone.
   */
  GetSystemDefaultId(): string | null {
    const tz = GetTZEnvironmentVariable();
    if (tz !== null) {
      // A TZ that names no zone means UTC, as it does for Node, Python, glibc and .NET on Unix.
      return this.ResolveId(tz) ?? this.ResolveId(this.UseWindowsIds ? "UTC" : "Etc/UTC") ?? (this.UseWindowsIds ? null : "Etc/UTC");
    }
    const local = GetIntlLocalId();
    if (local === null || !this.UseWindowsIds) {
      return local;
    }
    const windowsId = TryConvertIanaIdToWindowsId(local);
    return windowsId !== null && this.GetWindowsIds().indexOf(windowsId) !== -1 ? windowsId : local;
  }

  /**
   * The ID of the zone an ID (such as the TZ environment variable's) names, as one of {@link IntlSystemTimeZones.GetIds}:
   * with Windows IDs, a Windows ID (in its canonical case), or the Windows ID CLDR maps an IANA ID to; otherwise the IANA
   * ID, canonicalized by the host if it isn't one of its listed IDs. Null if it names no zone.
   */
  ResolveId(id: string): string | null {
    if (this.UseWindowsIds) {
      const windows = TryConvertWindowsIdToIanaId(id);
      if (windows !== null && this.GetWindowsIds().indexOf(windows.WindowsId) !== -1) {
        return windows.WindowsId;
      }
      const windowsId = IsIntlTimeZoneId(id) ? TryConvertIanaIdToWindowsId(id) : null;
      return windowsId !== null && this.GetWindowsIds().indexOf(windowsId) !== -1 ? windowsId : null;
    }
    if (!IsIntlTimeZoneId(id)) {
      return null;
    }
    // (Etc/UTC as is: hosts canonicalize it to "UTC", or list neither.)
    return GetSupportedIds().indexOf(id) !== -1 || id === "Etc/UTC" ? id : IntlCanonicalTimeZoneId(id);
  }

  /**
   * The host's default zone (cached while it doesn't change), or null if there isn't one.
   */
  ForSystemDefault(): SystemDateTimeZone | null {
    const id = this.GetSystemDefaultId();
    if (id === null) {
      return null;
    }
    let current = this._systemDefault;
    if (current?.Id !== id) {
      current = this.ForId(id);
      this._systemDefault = current;
    }
    return current;
  }

  /** The Windows IDs whose primary IANA zone the host supports. */
  private GetWindowsIds(): readonly string[] {
    if (this._windowsIds === undefined) {
      const ids: string[] = [];
      for (const windowsId of GetMappedWindowsIds()) {
        const mapping = TryConvertWindowsIdToIanaId(windowsId);
        if (mapping !== null && IsIntlTimeZoneId(mapping.IanaId)) {
          ids.push(windowsId);
        }
      }
      this._windowsIds = ids;
    }
    return this._windowsIds;
  }
}

function GetSupportedIds(): readonly string[] {
  return GetIntlSupportedTimeZones();
}

