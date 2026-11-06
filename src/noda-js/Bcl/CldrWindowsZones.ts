// noda-js: Windows (BCL) time zone IDs, mapped to tzdb zones using CLDR's windowsZones.xml.
//
// On any host, a Windows ID (e.g. "AUS Eastern Standard Time", as found in data produced by .NET apps) is mapped to
// its CLDR primary tzdb zone ("Australia/Sydney"), whose rules come from tzdb. (Windows' own rules have no
// redistributable source: noda-js/system reads them from the Windows machine it runs on, as .NET does.)

import { CreateReadOnlyList, MapZone, WindowsZones, type DateTimeZone, type IDateTimeZoneProvider } from "../internal.ts";
import { cldrWindowsZones } from "./CldrWindowsZones.generated.ts";

/** CLDR windowsZones data, as written by tools/NodaJs.Tools (cldr). */
export interface WindowsZonesData {
  readonly Version: string;
  readonly TzdbVersion: string;
  readonly WindowsVersion: string;
  readonly MapZones: readonly { readonly WindowsId: string; readonly Territory: string; readonly TzdbIds: readonly string[] }[];
}

let windowsZones: WindowsZones | undefined;

/**
 * The Windows ↔ tzdb mapping from the CLDR release bundled with noda-js. (A tzdb source also carries the
 * mapping from its NZD file: TzdbDateTimeZoneSource.WindowsMapping.)
 */
export function GetCldrWindowsZones(): WindowsZones {
  return (windowsZones ??= WindowsZones.NewVersionTzdbVersionWindowsVersionMapZones(
    cldrWindowsZones.Version,
    cldrWindowsZones.TzdbVersion,
    cldrWindowsZones.WindowsVersion,
    cldrWindowsZones.MapZones.map(z => new MapZone(z.WindowsId, z.Territory, [...z.TzdbIds])),
  ));
}

/**
 * Wraps a provider (normally tzdb) so it also accepts Windows zone IDs, mapping each to its CLDR
 * primary tzdb ID. Zones keep their tzdb IDs; only lookup accepts the Windows form.
 */
export class WindowsIdDateTimeZoneProvider implements IDateTimeZoneProvider {
  private _ids: readonly string[] | undefined;

  constructor(
    private readonly _provider: IDateTimeZoneProvider,
    private readonly _mapping: WindowsZones = GetCldrWindowsZones(),
  ) {}

  /** @inheritDoc */
  get VersionId(): string {
    return `${this._provider.VersionId} + CLDR windowsZones ${this._mapping.Version}`;
  }

  /**
   * The wrapped provider's IDs plus the Windows IDs this provider accepts (those with a CLDR primary mapping to one
   * of them), in ordinal order. Patterns parse zone IDs by searching this list, so a Windows ID must be in it for
   * e.g. `ZonedDateTime.fromJSON` to read "2024-04-01T01:30:00+11 AUS Eastern Standard Time".
   */
  get Ids(): readonly string[] {
    if (this._ids === undefined) {
      const ids = new Set(this._provider.Ids);
      this._mapping.PrimaryMapping.forEach((tzdbId, windowsId) => {
        if (this._provider.GetZoneOrNull(tzdbId) !== null) {
          ids.add(windowsId);
        }
      });
      // Array.prototype.sort compares UTF-16 code units: ordinal order, as IDateTimeZoneProvider.Ids requires.
      this._ids = CreateReadOnlyList(Array.from(ids).sort());
    }
    return this._ids;
  }

  /** @inheritDoc */
  GetSystemDefault(): DateTimeZone {
    return this._provider.GetSystemDefault();
  }

  /** @inheritDoc */
  GetZoneOrNull(id: string): DateTimeZone | null {
    const zone = this._provider.GetZoneOrNull(id);
    if (zone !== null) {
      return zone;
    }
    const tzdbId = this._mapping.PrimaryMapping.get(id);
    return tzdbId === undefined ? null : this._provider.GetZoneOrNull(tzdbId);
  }

  /** @inheritDoc */
  Get(id: string): DateTimeZone {
    const zone = this.GetZoneOrNull(id);
    if (zone === null) {
      // Same behaviour as the wrapped provider for unknown IDs.
      return this._provider.Get(id);
    }
    return zone;
  }

  /** The Windows ID CLDR maps to the given tzdb zone (for the "001" territory), if any. */
  WindowsIdForTzdbId(tzdbId: string): string | null {
    for (const mapZone of this._mapping.MapZones) {
      if (mapZone.Territory === MapZone.PrimaryTerritory && mapZone.TzdbIds.indexOf(tzdbId) !== -1) {
        return mapZone.WindowsId;
      }
    }
    return null;
  }
}
