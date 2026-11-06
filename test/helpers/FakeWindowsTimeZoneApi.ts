// A fake Windows for noda-js/system's tests: an IWindowsTimeZoneApi over an in-memory registry of time zones (the
// values .NET's TimeZoneInfo reads: Display, Std, Dlt, the MUI_ references, TZI and Dynamic DST), MUI string resources
// and GetDynamicTimeZoneInformation's result. The code under test is the same as on a real Windows machine; only the
// calls to Windows are replaced.

import type {
  IWindowsTimeZoneApi,
  WindowsDynamicTimeZoneInformation,
  WindowsRegistryValue,
  WindowsSystemTime,
} from "../../src/noda-js/System/Windows/IWindowsTimeZoneApi.ts";
import { CreateWindowsTimeZoneInfoShim, type ITimeZoneInfoShim } from "../../src/noda-js/TimeZones/TimeZoneInfoInterceptor.ts";

/** A SYSTEMTIME as [year, month, dayOfWeek, day, hour, minute, second, milliseconds]; all zero for "none". */
export type SystemTimeTuple = readonly [number, number, number, number, number, number, number, number];

export const NoDate: SystemTimeTuple = [0, 0, 0, 0, 0, 0, 0, 0];

/** A REG_TZI_FORMAT. Biases are minutes, UTC = local + bias. */
export interface FakeTzi {
  readonly Bias: number;
  readonly StandardBias?: number;
  readonly DaylightBias?: number;
  /** When daylight saving time ends. */
  readonly StandardDate?: SystemTimeTuple;
  /** When daylight saving time starts. */
  readonly DaylightDate?: SystemTimeTuple;
}

export interface FakeZone {
  /** The registry key name. */
  readonly Id: string;
  readonly Display?: string;
  readonly Std?: string;
  readonly Dlt?: string;
  readonly MuiDisplay?: string;
  readonly MuiStd?: string;
  readonly MuiDlt?: string;
  /** The TZI value, or raw bytes (to give invalid data). */
  readonly Tzi: FakeTzi | Uint8Array;
  /** The "Dynamic DST" subkey. */
  readonly Dynamic?: { readonly First: number | string; readonly Last: number; readonly Years: Readonly<Record<number, FakeTzi>> };
}

export interface FakeWindowsOptions {
  /** GetDynamicTimeZoneInformation's result (null: TIME_ZONE_ID_INVALID). Default: none set ("" key name, UTC). */
  readonly Local?: WindowsDynamicTimeZoneInformation | null;
  readonly Languages?: readonly string[];
  readonly SystemDirectory?: string;
  /** String resources, by MUI file path (case-insensitive) and resource ID. */
  readonly MuiFiles?: Readonly<Record<string, Readonly<Record<number, string>>>>;
}

const Hive = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Time Zones";

export function SystemTime(tuple: SystemTimeTuple): WindowsSystemTime {
  const [Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds] = tuple;
  return { Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds };
}

/** The 44 bytes of a REG_TZI_FORMAT. */
export function EncodeTzi(tzi: FakeTzi): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, tzi.Bias, true);
  view.setInt32(4, tzi.StandardBias ?? 0, true);
  view.setInt32(8, tzi.DaylightBias ?? 0, true);
  (tzi.StandardDate ?? NoDate).forEach((value, i) => view.setUint16(12 + 2 * i, value, true));
  (tzi.DaylightDate ?? NoDate).forEach((value, i) => view.setUint16(28 + 2 * i, value, true));
  return bytes;
}

/** A DYNAMIC_TIME_ZONE_INFORMATION for a zone (as GetDynamicTimeZoneInformation gives the current one). */
export function DynamicInformation(zone: FakeZone, options: { KeyName?: string; DynamicDaylightTimeDisabled?: boolean; Year?: number } = {}): WindowsDynamicTimeZoneInformation {
  let tzi = zone.Tzi as FakeTzi;
  if (zone.Dynamic !== undefined && options.Year !== undefined) {
    const year = Math.min(Math.max(options.Year, Number(zone.Dynamic.First)), zone.Dynamic.Last);
    tzi = zone.Dynamic.Years[year]!;
  }
  return {
    Bias: tzi.Bias,
    StandardName: zone.Std ?? "",
    StandardDate: SystemTime(tzi.StandardDate ?? NoDate),
    StandardBias: tzi.StandardBias ?? 0,
    DaylightName: zone.Dlt ?? "",
    DaylightDate: SystemTime(tzi.DaylightDate ?? NoDate),
    DaylightBias: tzi.DaylightBias ?? 0,
    TimeZoneKeyName: options.KeyName ?? zone.Id,
    DynamicDaylightTimeDisabled: options.DynamicDaylightTimeDisabled ?? false,
  };
}

interface Key {
  readonly Name: string;
  readonly Values: Map<string, WindowsRegistryValue>;
  readonly SubKeys: Key[];
}

export class FakeWindowsTimeZoneApi implements IWindowsTimeZoneApi {
  private readonly _keys = new Map<string, Key>();
  /** Every call made, by API name. */
  readonly Calls = new Map<string, number>();

  constructor(zones: readonly FakeZone[], private readonly _options: FakeWindowsOptions = {}) {
    const hive = this.AddKey(Hive);
    for (const zone of zones) {
      const key = this.AddKey(`${Hive}\\${zone.Id}`, hive);
      const set = (name: string, value: WindowsRegistryValue | undefined): void => {
        if (value !== undefined) {
          key.Values.set(name.toUpperCase(), value);
        }
      };
      set("Display", zone.Display);
      set("Std", zone.Std);
      set("Dlt", zone.Dlt);
      set("MUI_Display", zone.MuiDisplay);
      set("MUI_Std", zone.MuiStd);
      set("MUI_Dlt", zone.MuiDlt);
      set("TZI", zone.Tzi instanceof Uint8Array ? zone.Tzi : EncodeTzi(zone.Tzi));
      if (zone.Dynamic !== undefined) {
        const dynamic = this.AddKey(`${Hive}\\${zone.Id}\\Dynamic DST`, key);
        dynamic.Values.set("FIRSTENTRY", typeof zone.Dynamic.First === "number" ? zone.Dynamic.First : zone.Dynamic.First);
        dynamic.Values.set("LASTENTRY", zone.Dynamic.Last);
        for (const year of Object.keys(zone.Dynamic.Years)) {
          dynamic.Values.set(year, EncodeTzi(zone.Dynamic.Years[Number(year)]!));
        }
      }
    }
  }

  /** A TimeZoneInfoInterceptor shim reading this fake Windows, as the real one reads Windows through FFI. */
  CreateShim(description = "fake"): ITimeZoneInfoShim {
    return CreateWindowsTimeZoneInfoShim({ Backend: "ffi", Description: description, Api: this });
  }

  GetDynamicTimeZoneInformation(): WindowsDynamicTimeZoneInformation | null {
    this.Count("GetDynamicTimeZoneInformation");
    if (this._options.Local === undefined) {
      return DynamicInformation({ Id: "", Tzi: { Bias: 0 } });
    }
    return this._options.Local;
  }

  GetRegistrySubKeyNames(keyPath: string): readonly string[] | null {
    this.Count("GetRegistrySubKeyNames");
    const key = this._keys.get(keyPath.toUpperCase());
    return key === undefined ? null : key.SubKeys.map(subKey => subKey.Name);
  }

  RegistryKeyExists(keyPath: string): boolean {
    this.Count("RegistryKeyExists");
    return this._keys.has(keyPath.toUpperCase());
  }

  GetRegistryValue(keyPath: string, valueName: string): WindowsRegistryValue | null {
    this.Count("GetRegistryValue");
    return this._keys.get(keyPath.toUpperCase())?.Values.get(valueName.toUpperCase()) ?? null;
  }

  GetSystemDirectory(): string {
    return this._options.SystemDirectory ?? "C:\\Windows\\system32";
  }

  GetUserPreferredUILanguages(): readonly string[] {
    return this._options.Languages ?? ["en-US"];
  }

  FileExists(path: string): boolean {
    return this.FindMuiFile(path) !== undefined;
  }

  LoadString(filePath: string, resourceId: number): string {
    this.Count("LoadString");
    return this.FindMuiFile(filePath)?.[resourceId] ?? "";
  }

  private FindMuiFile(path: string): Readonly<Record<number, string>> | undefined {
    const files = this._options.MuiFiles ?? {};
    const name = Object.keys(files).find(file => file.toUpperCase() === path.toUpperCase());
    return name === undefined ? undefined : files[name];
  }

  private AddKey(path: string, parent?: Key): Key {
    const key: Key = { Name: path.substring(path.lastIndexOf("\\") + 1), Values: new Map(), SubKeys: [] };
    this._keys.set(path.toUpperCase(), key);
    parent?.SubKeys.push(key);
    return key;
  }

  private Count(name: string): void {
    this.Calls.set(name, (this.Calls.get(name) ?? 0) + 1);
  }
}

// #region Zones (their data as in Windows' registry)

export const UtcZone: FakeZone = {
  Id: "UTC",
  Display: "(UTC) Coordinated Universal Time",
  Std: "Coordinated Universal Time",
  Dlt: "Coordinated Universal Time",
  MuiDisplay: "@tzres.dll,-930",
  MuiStd: "@tzres.dll,-932",
  MuiDlt: "@tzres.dll,-931",
  Tzi: { Bias: 0 },
};

export const UtcMinus02Zone: FakeZone = {
  Id: "UTC-02",
  Display: "(UTC-02:00) Coordinated Universal Time-02",
  Std: "UTC-02",
  Dlt: "UTC-02",
  MuiDisplay: "@tzres.dll,-1160",
  MuiStd: "@tzres.dll,-1162",
  MuiDlt: "@tzres.dll,-1161",
  Tzi: { Bias: 120 },
};

export const SaWesternZone: FakeZone = {
  Id: "SA Western Standard Time",
  Display: "(UTC-04:00) Georgetown, La Paz, Manaus, San Juan",
  Std: "SA Western Standard Time",
  Dlt: "SA Western Summer Time",
  Tzi: { Bias: 240 },
};

export const AusEasternZone: FakeZone = {
  Id: "AUS Eastern Standard Time",
  Display: "(UTC+10:00) Canberra, Melbourne, Sydney",
  Std: "AUS Eastern Standard Time",
  Dlt: "AUS Eastern Summer Time",
  MuiDisplay: "@tzres.dll,-670",
  MuiStd: "@tzres.dll,-672",
  MuiDlt: "@tzres.dll,-671",
  Tzi: { Bias: -600, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 3, 0, 0, 0], DaylightDate: [0, 10, 0, 1, 2, 0, 0, 0] },
  Dynamic: {
    First: 2007,
    Last: 2008,
    Years: {
      2007: { Bias: -600, DaylightBias: -60, StandardDate: [0, 3, 0, 5, 3, 0, 0, 0], DaylightDate: [0, 10, 0, 5, 2, 0, 0, 0] },
      2008: { Bias: -600, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 3, 0, 0, 0], DaylightDate: [0, 10, 0, 1, 2, 0, 0, 0] },
    },
  },
};

/** Brazil: DST transitions at 24:00, which Windows writes as 23:59:59.999. */
export const ESouthAmericaZone: FakeZone = {
  Id: "E. South America Standard Time",
  Display: "(UTC-03:00) Brasilia",
  Std: "E. South America Standard Time",
  Dlt: "E. South America Daylight Time",
  Tzi: { Bias: 180, DaylightBias: -60 },
  Dynamic: {
    First: 2010,
    Last: 2020,
    Years: {
      2010: { Bias: 180, DaylightBias: -60, StandardDate: [0, 2, 6, 3, 23, 59, 59, 999], DaylightDate: [0, 10, 6, 3, 23, 59, 59, 999] },
      2011: { Bias: 180, DaylightBias: -60, StandardDate: [0, 2, 6, 3, 23, 59, 59, 999], DaylightDate: [0, 10, 6, 3, 23, 59, 59, 999] },
      2012: { Bias: 180, DaylightBias: -60, StandardDate: [0, 2, 6, 4, 23, 59, 59, 999], DaylightDate: [0, 10, 6, 3, 23, 59, 59, 999] },
      2013: { Bias: 180, DaylightBias: -60, StandardDate: [0, 2, 6, 3, 23, 59, 59, 999], DaylightDate: [0, 10, 6, 3, 23, 59, 59, 999] },
      2014: { Bias: 180, DaylightBias: -60, StandardDate: [0, 2, 6, 3, 23, 59, 59, 999], DaylightDate: [0, 10, 6, 3, 23, 59, 59, 999] },
      2015: { Bias: 180, DaylightBias: -60, StandardDate: [0, 2, 6, 3, 23, 59, 59, 999], DaylightDate: [0, 10, 6, 3, 23, 59, 59, 999] },
      2016: { Bias: 180, DaylightBias: -60, StandardDate: [0, 2, 6, 3, 23, 59, 59, 999], DaylightDate: [0, 10, 6, 3, 23, 59, 59, 999] },
      2017: { Bias: 180, DaylightBias: -60, StandardDate: [0, 2, 6, 3, 23, 59, 59, 999], DaylightDate: [0, 10, 6, 2, 23, 59, 59, 999] },
      2018: { Bias: 180, DaylightBias: -60, StandardDate: [0, 2, 6, 3, 23, 59, 59, 999], DaylightDate: [0, 11, 6, 1, 23, 59, 59, 999] },
      2019: { Bias: 180, DaylightBias: -60, StandardDate: [0, 2, 0, 3, 0, 0, 0, 0], DaylightDate: [0, 1, 2, 1, 0, 0, 0, 0] },
      2020: { Bias: 180, DaylightBias: -60 },
    },
  },
};

/** Samoa: crossed the date line at the end of 2011 (UTC-11 → UTC+13), so its rules have their own base offsets. */
export const SamoaZone: FakeZone = {
  Id: "Samoa Standard Time",
  Display: "(UTC+13:00) Samoa",
  Std: "Samoa Standard Time",
  Dlt: "Samoa Daylight Time",
  Tzi: { Bias: -780, DaylightBias: -60 },
  Dynamic: {
    First: 2009,
    Last: 2022,
    Years: {
      2009: { Bias: 660, DaylightBias: -60 },
      2010: { Bias: 660, DaylightBias: -60, StandardDate: [0, 1, 5, 1, 0, 0, 0, 0], DaylightDate: [0, 9, 0, 5, 0, 0, 0, 0] },
      2011: { Bias: 660, DaylightBias: -60, StandardDate: [0, 4, 6, 1, 4, 0, 0, 0], DaylightDate: [0, 9, 6, 4, 3, 0, 0, 0] },
      2012: { Bias: -780, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 4, 0, 0, 0], DaylightDate: [0, 9, 0, 5, 3, 0, 0, 0] },
      2013: { Bias: -780, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 4, 0, 0, 0], DaylightDate: [0, 9, 0, 5, 3, 0, 0, 0] },
      2014: { Bias: -780, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 4, 0, 0, 0], DaylightDate: [0, 9, 0, 5, 3, 0, 0, 0] },
      2015: { Bias: -780, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 4, 0, 0, 0], DaylightDate: [0, 9, 0, 5, 3, 0, 0, 0] },
      2016: { Bias: -780, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 4, 0, 0, 0], DaylightDate: [0, 9, 0, 5, 3, 0, 0, 0] },
      2017: { Bias: -780, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 4, 0, 0, 0], DaylightDate: [0, 9, 0, 5, 3, 0, 0, 0] },
      2018: { Bias: -780, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 4, 0, 0, 0], DaylightDate: [0, 9, 0, 5, 3, 0, 0, 0] },
      2019: { Bias: -780, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 4, 0, 0, 0], DaylightDate: [0, 9, 0, 5, 3, 0, 0, 0] },
      2020: { Bias: -780, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 4, 0, 0, 0], DaylightDate: [0, 9, 0, 5, 3, 0, 0, 0] },
      2021: { Bias: -780, DaylightBias: -60, StandardDate: [0, 4, 0, 1, 4, 0, 0, 0], DaylightDate: [0, 1, 5, 1, 0, 0, 0, 0] },
      2022: { Bias: -780, DaylightBias: -60 },
    },
  },
};

// #endregion

/** The zones above. */
export const FakeZones: readonly FakeZone[] = [UtcZone, UtcMinus02Zone, SaWesternZone, AusEasternZone, ESouthAmericaZone, SamoaZone];
