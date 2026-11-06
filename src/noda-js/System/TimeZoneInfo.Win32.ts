// noda-js: port of System.TimeZoneInfo's Windows implementation from dotnet/runtime
// (src/libraries/System.Private.CoreLib/src/System/TimeZoneInfo.Win32.cs, and the static members of TimeZoneInfo.cs
// that use it: Local, Utc, FindSystemTimeZoneById, GetSystemTimeZones and their cache). It reads the time zones from
// the registry exactly as .NET does, through an IWindowsTimeZoneApi (FFI, a native addon, or a test's fake).
// Copyright (c) .NET Foundation and Contributors. Licensed under the MIT license (see NOTICE.txt).
//
// .NET's static cache (CachedData) is an instance here, one per API, so tests can use their own data.
// Not ported: TimeZoneInfo.Invariant (DOTNET_SYSTEM_TIMEZONE_INVARIANT), GlobalizationMode, the one-year local zone
// used by DateTime.Now, and serialization.

import { IsNodaError, NewArgumentNullException, NewInvalidCastException, NewTimeZoneNotFoundException, NewInvalidTimeZoneException } from "../internal.ts";
import type { InvalidTimeZoneException, TimeZoneNotFoundException } from "../internal.ts";
import { DateTime, TimeSpanFromMinutes } from "./DateTime.ts";
import { TimeZoneInfo } from "./TimeZoneInfo.ts";
import { TimeZoneInfoAdjustmentRule } from "./TimeZoneInfo.AdjustmentRule.ts";
import { TimeZoneInfoTransitionTime } from "./TimeZoneInfo.TransitionTime.ts";
import { GetLocalTimeZoneFromTZ } from "./LocalTimeZoneFromTZ.ts";
import type { IWindowsTimeZoneApi, WindowsDynamicTimeZoneInformation, WindowsSystemTime } from "./Windows/IWindowsTimeZoneApi.ts";
import { TryConvertIanaIdToWindowsId } from "./WindowsIdMapping.ts";

// registry constants for the 'Time Zones' hive
//
const TimeZonesRegistryHive = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Time Zones";
const DisplayValue = "Display";
const DaylightValue = "Dlt";
const StandardValue = "Std";
const MuiDisplayValue = "MUI_Display";
const MuiDaylightValue = "MUI_Dlt";
const MuiStandardValue = "MUI_Std";
const TimeZoneInfoValue = "TZI";
const FirstEntryValue = "FirstEntry";
const LastEntryValue = "LastEntry";

const InvariantUtcStandardDisplayName = "Coordinated Universal Time";

const UtcId = "UTC";
const LocalId = "Local";
const MaxKeyLength = 255;

/** sizeof(REG_TZI_FORMAT). */
const RegTziFormatSize = 44;

/** Interop.Kernel32.REG_TZI_FORMAT: the "TZI" registry values. */
interface RegTziFormat {
  readonly Bias: number;
  readonly StandardBias: number;
  readonly DaylightBias: number;
  readonly StandardDate: WindowsSystemTime;
  readonly DaylightDate: WindowsSystemTime;
}

/** Interop.Kernel32.TIME_ZONE_INFORMATION (the parts of DYNAMIC_TIME_ZONE_INFORMATION it copies). */
interface TimeZoneInformation extends RegTziFormat {
  readonly StandardName: string;
  readonly DaylightName: string;
}

/** TimeZoneInfoResult. (Not ported: SecurityException, which reading the registry here can't give.) */
const TimeZoneInfoResult = {
  Success: 0,
  TimeZoneNotFoundException: 1,
  InvalidTimeZoneException: 2,
} as const;
type TimeZoneInfoResult = (typeof TimeZoneInfoResult)[keyof typeof TimeZoneInfoResult];

function SystemTimeEquals(a: WindowsSystemTime, b: WindowsSystemTime): boolean {
  return a.Year === b.Year && a.Month === b.Month && a.DayOfWeek === b.DayOfWeek && a.Day === b.Day &&
    a.Hour === b.Hour && a.Minute === b.Minute && a.Second === b.Second && a.Milliseconds === b.Milliseconds;
}

function ReadRegTziFormat(bytes: Uint8Array): RegTziFormat {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const systemTime = (offset: number): WindowsSystemTime => ({
    Year: view.getUint16(offset, true),
    Month: view.getUint16(offset + 2, true),
    DayOfWeek: view.getUint16(offset + 4, true),
    Day: view.getUint16(offset + 6, true),
    Hour: view.getUint16(offset + 8, true),
    Minute: view.getUint16(offset + 10, true),
    Second: view.getUint16(offset + 12, true),
    Milliseconds: view.getUint16(offset + 14, true),
  });
  return {
    Bias: view.getInt32(0, true),
    StandardBias: view.getInt32(4, true),
    DaylightBias: view.getInt32(8, true),
    StandardDate: systemTime(12),
    DaylightDate: systemTime(28),
  };
}

/** new TIME_ZONE_INFORMATION(in TIME_DYNAMIC_ZONE_INFORMATION). */
function TimeZoneInformationFromDynamic(dtzi: WindowsDynamicTimeZoneInformation): TimeZoneInformation {
  return {
    Bias: dtzi.Bias,
    StandardName: dtzi.StandardName,
    StandardDate: dtzi.StandardDate,
    StandardBias: dtzi.StandardBias,
    DaylightName: dtzi.DaylightName,
    DaylightDate: dtzi.DaylightDate,
    DaylightBias: dtzi.DaylightBias,
  };
}

/** CultureInfo.Parent, for the names .NET looks for tzres.dll.mui under: "en-GB" → "en" → "" (invariant). */
function ParentCultureName(name: string): string {
  const index = name.lastIndexOf("-");
  return index < 0 ? "" : name.substring(0, index);
}

/**
 * The system time zones of one Windows machine (as seen through an IWindowsTimeZoneApi), as .NET's TimeZoneInfo
 * reads them: the counterpart of TimeZoneInfo's static members and their cache (CachedData).
 * @internal
 */
export class TimeZoneInfoCachedData {
  private _localTimeZone: TimeZoneInfo | null = null;
  private _utcTimeZone: TimeZoneInfo | null = null;
  /** Keyed by the upper-cased ID (StringComparer.OrdinalIgnoreCase); insertion-ordered, as .NET's Dictionary is. */
  private _systemTimeZones: Map<string, TimeZoneInfo> | null = null;
  private _readOnlySystemTimeZones: readonly TimeZoneInfo[] | null = null;
  private _timeZonesUsingAlternativeIds: Map<string, TimeZoneInfo> | null = null;
  private _allSystemTimeZonesRead = false;

  constructor(private readonly _api: IWindowsTimeZoneApi) {}

  /** The API the data is read through. */
  get Api(): IWindowsTimeZoneApi {
    return this._api;
  }

  // #region TimeZoneInfo.cs (static members)

  /**
   * TimeZoneInfo.Local: the local time zone (from GetDynamicTimeZoneInformation).
   */
  get Local(): TimeZoneInfo {
    return this._localTimeZone ?? this.CreateLocal();
  }

  /** TimeZoneInfo.Utc. */
  get Utc(): TimeZoneInfo {
    return (this._utcTimeZone ??= this.CreateUtcTimeZone());
  }

  private CreateLocal(): TimeZoneInfo {
    let timeZone = this._localTimeZone;
    if (timeZone === null) {
      // noda-js: the zone the TZ environment variable names, if it's set (see LocalTimeZoneFromTZ.ts).
      timeZone = GetLocalTimeZoneFromTZ(this) ?? this.GetLocalTimeZone();

      // this step is to break the reference equality
      // between TimeZoneInfo.Local and a second time zone
      // such as "Pacific Standard Time"
      timeZone = TimeZoneInfo.NewIdBaseUtcOffsetDisplayNameStandardDisplayNameDaylightDisplayNameAdjustmentRulesDisableDaylightSavingTimeHasIanaId(
        timeZone.Id,
        timeZone.BaseUtcOffset,
        timeZone.DisplayName,
        timeZone.StandardName,
        timeZone.DaylightName,
        timeZone.AdjustmentRulesOrNull,
        false,
        timeZone.HasIanaId);

      this._localTimeZone = timeZone;
    }
    return timeZone;
  }

  /**
   * TimeZoneInfo.FindSystemTimeZoneById.
   * @throws {TimeZoneNotFoundException} The zone wasn't found.
   * @throws {InvalidTimeZoneException} The zone's data is invalid.
   */
  FindSystemTimeZoneById(id: string): TimeZoneInfo {
    const { Result: result, Value: value, Error: e } = this.TryFindSystemTimeZoneById(id);
    switch (result) {
      case TimeZoneInfoResult.Success:
        return value!;
      case TimeZoneInfoResult.InvalidTimeZoneException:
        throw e ?? NewInvalidTimeZoneException(`The time zone ID '${id}' was found on the local computer, but the registry information was corrupt.`);
      default:
        throw NewTimeZoneNotFoundException(`The time zone ID '${id}' was not found on the local computer.`, e === null ? undefined : { cause: e });
    }
  }

  private TryFindSystemTimeZoneById(id: string): { Result: TimeZoneInfoResult; Value: TimeZoneInfo | null; Error: Error | null } {
    // Special case for Utc as it will not exist in the dictionary with the rest
    // of the system time zones.  There is no need to do this check for Local.Id
    // since Local is a real time zone that exists in the dictionary cache
    if (id !== null && id !== undefined && id.toUpperCase() === UtcId) {
      return { Result: TimeZoneInfoResult.Success, Value: this.Utc, Error: null };
    }

    if (id === null || id === undefined) {
      throw NewArgumentNullException("id");
    }
    if (id.length === 0 || id.length > MaxKeyLength || id.indexOf("\0") !== -1) {
      return { Result: TimeZoneInfoResult.TimeZoneNotFoundException, Value: null, Error: null };
    }

    return this.TryGetTimeZone(id, false, false);
  }

  /**
   * TimeZoneInfo.GetSystemTimeZones(): every valid zone in the registry, sorted by base offset, then display name.
   */
  GetSystemTimeZones(): readonly TimeZoneInfo[] {
    if (this._readOnlySystemTimeZones === null) {
      if (!this._allSystemTimeZonesRead) {
        this.PopulateAllSystemTimeZones();
        this._allSystemTimeZonesRead = true;
      }

      if (this._systemTimeZones !== null) {
        // return a collection of the cached system time zones
        const array: TimeZoneInfo[] = [];
        this._systemTimeZones.forEach(zone => array.push(zone));

        // sort and copy the TimeZoneInfo's into a ReadOnlyCollection for the user
        // (Array.Sort is unstable, but no two zones compare equal: their display names differ.)
        array.sort((x, y) => {
          // sort by BaseUtcOffset first and by DisplayName second - this is similar to the Windows Date/Time control panel
          const comparison = x.BaseUtcOffset - y.BaseUtcOffset;
          return comparison === 0 ? CompareOrdinal(x.DisplayName, y.DisplayName) : comparison;
        });
        this._readOnlySystemTimeZones = Object.freeze(array);
      } else {
        this._readOnlySystemTimeZones = Object.freeze([]);
      }
    }
    return this._readOnlySystemTimeZones;
  }

  private TryGetTimeZone(id: string, dstDisabled: boolean, alwaysFallbackToLocalMachine: boolean): { Result: TimeZoneInfoResult; Value: TimeZoneInfo | null; Error: Error | null } {
    let found = this.TryGetTimeZoneUsingId(id, dstDisabled, alwaysFallbackToLocalMachine);
    if (found.Result !== TimeZoneInfoResult.Success) {
      const alternativeId = this.GetAlternativeId(id);
      if (alternativeId !== null) {
        found = this.TryGetTimeZoneUsingId(alternativeId, dstDisabled, alwaysFallbackToLocalMachine);
        if (found.Result === TimeZoneInfoResult.Success) {
          const value = found.Value!;
          const idIsIana = true;
          let zone: TimeZoneInfo | null = null;
          if (value._equivalentZones === null) {
            zone = TimeZoneInfo.NewIdBaseUtcOffsetDisplayNameStandardDisplayNameDaylightDisplayNameAdjustmentRulesDisableDaylightSavingTimeHasIanaId(
              id, value.BaseUtcOffset, value.DisplayName, value.StandardName, value.DaylightName, value.AdjustmentRulesOrNull,
              dstDisabled && value.SupportsDaylightSavingTime, idIsIana);
            value._equivalentZones = [zone];
          } else {
            for (const tzi of value._equivalentZones) {
              if (tzi.Id === id) {
                zone = tzi;
                break;
              }
            }
            if (zone === null) {
              zone = TimeZoneInfo.NewIdBaseUtcOffsetDisplayNameStandardDisplayNameDaylightDisplayNameAdjustmentRulesDisableDaylightSavingTimeHasIanaId(
                id, value.BaseUtcOffset, value.DisplayName, value.StandardName, value.DaylightName, value.AdjustmentRulesOrNull,
                dstDisabled && value.SupportsDaylightSavingTime, idIsIana);
              value._equivalentZones.push(zone);
            }
          }

          this._timeZonesUsingAlternativeIds ??= new Map<string, TimeZoneInfo>();
          this._timeZonesUsingAlternativeIds.set(id.toUpperCase(), zone);

          found = { Result: found.Result, Value: zone, Error: found.Error };
        }
      }
    }

    return found;
  }

  private TryGetTimeZoneUsingId(id: string, dstDisabled: boolean, alwaysFallbackToLocalMachine: boolean): { Result: TimeZoneInfoResult; Value: TimeZoneInfo | null; Error: Error | null } {
    // check the cache
    if (this._systemTimeZones !== null) {
      let value = this._systemTimeZones.get(id.toUpperCase());
      if (value !== undefined) {
        if (dstDisabled && value.SupportsDaylightSavingTime) {
          // we found a cache hit but we want a time zone without DST and this one has DST data
          value = TimeZoneInfo.CreateCustomTimeZone(value.Id, value.BaseUtcOffset, value.DisplayName, value.StandardName);
        }

        return { Result: TimeZoneInfoResult.Success, Value: value, Error: null };
      }
    }

    if (this._timeZonesUsingAlternativeIds !== null) {
      let value = this._timeZonesUsingAlternativeIds.get(id.toUpperCase());
      if (value !== undefined) {
        if (dstDisabled && value.SupportsDaylightSavingTime) {
          // we found a cache hit but we want a time zone without DST and this one has DST data
          value = TimeZoneInfo.CreateCustomTimeZone(value.Id, value.BaseUtcOffset, value.DisplayName, value.StandardName);
        }

        return { Result: TimeZoneInfoResult.Success, Value: value, Error: null };
      }
    }

    // Fall back to reading from the local machine when the cache is not fully populated.
    if (!this._allSystemTimeZonesRead || alwaysFallbackToLocalMachine) {
      return this.TryGetTimeZoneFromLocalMachineAndCache(id, dstDisabled);
    }
    return { Result: TimeZoneInfoResult.TimeZoneNotFoundException, Value: null, Error: null };
  }

  private TryGetTimeZoneFromLocalMachineAndCache(id: string, dstDisabled: boolean): { Result: TimeZoneInfoResult; Value: TimeZoneInfo | null; Error: Error | null } {
    const found = this.TryGetTimeZoneFromLocalMachine(id);
    let value = found.Value;

    if (found.Result === TimeZoneInfoResult.Success) {
      if (this._systemTimeZones === null) {
        this._systemTimeZones = new Map<string, TimeZoneInfo>();
        this._systemTimeZones.set(UtcId, this.Utc);
      }

      // Avoid using multiple Utc objects to ensure consistency and correctness as we have some code
      // uses reference equality with the Utc object.
      if (id.toUpperCase() !== UtcId) {
        // (Dictionary.Add throws for a duplicate key; the cache was checked first.)
        this._systemTimeZones.set(id.toUpperCase(), value!);
      }

      if (dstDisabled && value!.SupportsDaylightSavingTime) {
        // we found a cache hit but we want a time zone without DST and this one has DST data
        value = TimeZoneInfo.CreateCustomTimeZone(value!.Id, value!.BaseUtcOffset, value!.DisplayName, value!.StandardName);
      }
    }

    return { Result: found.Result, Value: value, Error: found.Error };
  }

  // Helper function to create the static UTC time zone instance
  private CreateUtcTimeZone(): TimeZoneInfo {
    const standardDisplayName = this.GetUtcStandardDisplayName();
    const displayName = TimeZoneInfoCachedData.GetUtcFullDisplayName(UtcId, standardDisplayName);
    return TimeZoneInfo.CreateCustomTimeZone(UtcId, 0, displayName, standardDisplayName);
  }

  // #endregion

  // #region TimeZoneInfo.Win32.cs

  private PopulateAllSystemTimeZones(): void {
    if (this._systemTimeZones === null) {
      this._systemTimeZones = new Map<string, TimeZoneInfo>();
      this._systemTimeZones.set(UtcId, this.Utc);
    }

    const keyNames = this._api.GetRegistrySubKeyNames(TimeZonesRegistryHive);
    if (keyNames !== null) {
      for (const keyName of keyNames) {
        this.TryGetTimeZone(keyName, false, false); // populate the cache
      }
    }
  }

  private GetAlternativeId(id: string): string | null {
    return TryConvertIanaIdToWindowsId(id);
  }

  /**
   * private TimeZoneInfo(in TIME_ZONE_INFORMATION zone, bool dstDisabled)
   */
  private static FromTimeZoneInformation(zone: TimeZoneInformation, dstDisabled: boolean): TimeZoneInfo {
    const standardName = zone.StandardName;
    // the ID must contain at least 1 character - initialize _id to "Local"
    const id = standardName.length === 0 ? LocalId : standardName;
    const baseUtcOffset = TimeSpanFromMinutes(-zone.Bias);

    let adjustmentRules: TimeZoneInfoAdjustmentRule[] | null = null;
    if (!dstDisabled) {
      // only create the adjustment rule if DST is enabled
      const regZone: RegTziFormat = zone;
      const rule = TimeZoneInfoCachedData.CreateAdjustmentRuleFromTimeZoneInformation(regZone, DateTime.MinValue.Date, DateTime.MaxValue.Date, zone.Bias);
      if (rule !== null) {
        adjustmentRules = [rule];
      }
    }

    // (.NET sets the fields directly, with _displayName = _standardDisplayName = standardName.)
    return TimeZoneInfo.NewIdBaseUtcOffsetDisplayNameStandardDisplayNameDaylightDisplayNameAdjustmentRulesDisableDaylightSavingTimeHasIanaId(
      id, baseUtcOffset, standardName, standardName, zone.DaylightName, adjustmentRules, false);
  }

  /**
   * Helper function to check if the current TimeZoneInformation struct does not support DST.
   * This check returns true when the DaylightDate == StandardDate.
   * This check is only meant to be used for "Local".
   */
  private static CheckDaylightSavingTimeNotSupported(timeZone: TimeZoneInformation): boolean {
    return SystemTimeEquals(timeZone.DaylightDate, timeZone.StandardDate);
  }

  /**
   * Converts a REG_TZI_FORMAT struct to an AdjustmentRule.
   */
  private static CreateAdjustmentRuleFromTimeZoneInformation(timeZoneInformation: RegTziFormat, startDate: DateTime, endDate: DateTime, defaultBaseUtcOffset: number): TimeZoneInfoAdjustmentRule | null {
    const supportsDst = timeZoneInformation.StandardDate.Month !== 0;

    if (!supportsDst) {
      if (timeZoneInformation.Bias === defaultBaseUtcOffset) {
        // this rule will not contain any information to be used to adjust dates. just ignore it
        return null;
      }

      return TimeZoneInfoAdjustmentRule.CreateAdjustmentRule(
        startDate,
        endDate,
        0, // no daylight saving transition
        TimeZoneInfoTransitionTime.CreateFixedDateRule(DateTime.MinValue, 1, 1),
        TimeZoneInfoTransitionTime.CreateFixedDateRule(DateTime.MinValue.AddMilliseconds(1), 1, 1),
        TimeSpanFromMinutes(defaultBaseUtcOffset - timeZoneInformation.Bias)); // Bias delta is all what we need from this rule
    }

    //
    // Create an AdjustmentRule with TransitionTime objects
    //
    const daylightTransitionStart = TimeZoneInfoCachedData.TransitionTimeFromTimeZoneInformation(timeZoneInformation, true);
    if (daylightTransitionStart === null) {
      return null;
    }

    const daylightTransitionEnd = TimeZoneInfoCachedData.TransitionTimeFromTimeZoneInformation(timeZoneInformation, false);
    if (daylightTransitionEnd === null) {
      return null;
    }

    if (daylightTransitionStart.Equals(daylightTransitionEnd)) {
      // this happens when the time zone does support DST but the OS has DST disabled
      return null;
    }

    return TimeZoneInfoAdjustmentRule.CreateAdjustmentRule(
      startDate,
      endDate,
      TimeSpanFromMinutes(-timeZoneInformation.DaylightBias),
      daylightTransitionStart,
      daylightTransitionEnd,
      TimeSpanFromMinutes(defaultBaseUtcOffset - timeZoneInformation.Bias));
  }

  /**
   * Helper function that searches the registry for a time zone entry
   * that matches the TimeZoneInformation struct.
   */
  private FindIdFromTimeZoneInformation(timeZone: TimeZoneInformation): { Id: string | null; DstDisabled: boolean } {
    let dstDisabled = false;

    const keyNames = this._api.GetRegistrySubKeyNames(TimeZonesRegistryHive);
    if (keyNames === null) {
      return { Id: null, DstDisabled: dstDisabled };
    }

    for (const keyName of keyNames) {
      const compared = this.TryCompareTimeZoneInformationToRegistry(timeZone, keyName);
      dstDisabled = compared.DstDisabled;
      if (compared.Result) {
        return { Id: keyName, DstDisabled: dstDisabled };
      }
    }

    return { Id: null, DstDisabled: dstDisabled };
  }

  /**
   * Helper function for retrieving the local system time zone.
   */
  private GetLocalTimeZone(): TimeZoneInfo {
    //
    // Try using the "kernel32!GetDynamicTimeZoneInformation" API to get the "id"
    //

    // call kernel32!GetDynamicTimeZoneInformation...
    const dynamicTimeZoneInformation = this._api.GetDynamicTimeZoneInformation();
    if (dynamicTimeZoneInformation === null) {
      // return a dummy entry
      return TimeZoneInfo.CreateCustomTimeZone(LocalId, 0, LocalId, LocalId);
    }

    // check to see if we can use the key name returned from the API call
    const dynamicTimeZoneKeyName = dynamicTimeZoneInformation.TimeZoneKeyName;
    if (dynamicTimeZoneKeyName.length !== 0) {
      const found = this.TryGetTimeZone(dynamicTimeZoneKeyName, dynamicTimeZoneInformation.DynamicDaylightTimeDisabled, false);
      if (found.Result === TimeZoneInfoResult.Success) {
        // successfully loaded the time zone from the registry
        return found.Value!;
      }
    }

    const timeZoneInformation = TimeZoneInformationFromDynamic(dynamicTimeZoneInformation);

    // the key name was not returned or it pointed to a bogus entry - search for the entry ourselves
    const { Id: id, DstDisabled: dstDisabled } = this.FindIdFromTimeZoneInformation(timeZoneInformation);

    if (id !== null) {
      const found = this.TryGetTimeZone(id, dstDisabled, false);
      if (found.Result === TimeZoneInfoResult.Success) {
        // successfully loaded the time zone from the registry
        return found.Value!;
      }
    }

    // We could not find the data in the registry.  Fall back to using
    // the data from the Win32 API
    return TimeZoneInfoCachedData.GetLocalTimeZoneFromWin32Data(timeZoneInformation, dstDisabled);
  }

  /**
   * Helper function used by 'GetLocalTimeZone()' - this function wraps a bunch of
   * try/catch logic for handling the TimeZoneInfo private constructor that takes
   * a TIME_ZONE_INFORMATION structure.
   */
  private static GetLocalTimeZoneFromWin32Data(timeZoneInformation: TimeZoneInformation, dstDisabled: boolean): TimeZoneInfo {
    // first try to create the TimeZoneInfo with the original 'dstDisabled' flag
    try {
      return TimeZoneInfoCachedData.FromTimeZoneInformation(timeZoneInformation, dstDisabled);
    } catch (e) {
      if (!IsNodaError(e, "ArgumentException") && !IsNodaError(e, "InvalidTimeZoneException")) {
        throw e;
      }
    }

    // if 'dstDisabled' was false then try passing in 'true' as a last ditch effort
    if (!dstDisabled) {
      try {
        return TimeZoneInfoCachedData.FromTimeZoneInformation(timeZoneInformation, true);
      } catch (e) {
        if (!IsNodaError(e, "ArgumentException") && !IsNodaError(e, "InvalidTimeZoneException")) {
          throw e;
        }
      }
    }

    // the data returned from Windows is completely bogus; return a dummy entry
    return TimeZoneInfo.CreateCustomTimeZone(LocalId, 0, LocalId, LocalId);
  }

  /**
   * Converts a REG_TZI_FORMAT struct to a TransitionTime
   * - When the argument 'readStart' is true the corresponding daylightTransitionTimeStart field is read
   * - When the argument 'readStart' is false the corresponding dayightTransitionTimeEnd field is read
   * @returns The transition time, or null (.NET's false).
   */
  private static TransitionTimeFromTimeZoneInformation(timeZoneInformation: RegTziFormat, readStartDate: boolean): TimeZoneInfoTransitionTime | null {
    //
    // SYSTEMTIME -
    //
    // If the time zone does not support daylight saving time or if the caller needs
    // to disable daylight saving time, the wMonth member in the SYSTEMTIME structure
    // must be zero. If this date is specified, the DaylightDate value in the
    // TIME_ZONE_INFORMATION structure must also be specified. Otherwise, the system
    // assumes the time zone data is invalid and no changes will be applied.
    //
    const supportsDst = timeZoneInformation.StandardDate.Month !== 0;

    if (!supportsDst) {
      return null;
    }

    //
    // SYSTEMTIME -
    //
    // * FixedDateRule -
    //   If the Year member is not zero, the transition date is absolute; it will only occur one time
    //
    // * FloatingDateRule -
    //   To select the correct day in the month, set the Year member to zero, the Hour and Minute
    //   members to the transition time, the DayOfWeek member to the appropriate weekday, and the
    //   Day member to indicate the occurrence of the day of the week within the month (first through fifth).
    //
    //   Using this notation, specify the 2:00a.m. on the first Sunday in April as follows:
    //   Hour      = 2,
    //   Month     = 4,
    //   DayOfWeek = 0,
    //   Day       = 1.
    //
    //   Specify 2:00a.m. on the last Thursday in October as follows:
    //   Hour      = 2,
    //   Month     = 10,
    //   DayOfWeek = 4,
    //   Day       = 5.
    //
    // (The "daylightTransitionStart" is read from DaylightDate, the "daylightTransitionEnd" from StandardDate.)
    const date = readStartDate ? timeZoneInformation.DaylightDate : timeZoneInformation.StandardDate;
    const timeOfDay = DateTime.Create(1 /* year */, 1 /* month */, 1 /* day */, date.Hour, date.Minute, date.Second, date.Milliseconds);
    if (date.Year === 0) {
      return TimeZoneInfoTransitionTime.CreateFloatingDateRule(timeOfDay, date.Month, date.Day /* Week 1-5 */, date.DayOfWeek);
    } else {
      return TimeZoneInfoTransitionTime.CreateFixedDateRule(timeOfDay, date.Month, date.Day);
    }
  }

  /**
   * Helper function that takes:
   *  1. A string representing a time_zone_name registry key name.
   *  2. A REG_TZI_FORMAT struct containing the default rule.
   *  3. An AdjustmentRule[] out-parameter.
   */
  private TryCreateAdjustmentRules(id: string, defaultTimeZoneInformation: RegTziFormat, defaultBaseUtcOffset: number): { Success: boolean; Rules: TimeZoneInfoAdjustmentRule[] | null; Error: Error | null } {
    let rules: TimeZoneInfoAdjustmentRule[] | null = null;

    try {
      // Optional, Dynamic Time Zone Registry Data
      // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
      //
      // HKLM
      //     Software
      //         Microsoft
      //             Windows NT
      //                 CurrentVersion
      //                     Time Zones
      //                         <time_zone_name>
      //                             Dynamic DST
      // * "FirstEntry" REG_DWORD "1980"
      //                           First year in the table. If the current year is less than this value,
      //                           this entry will be used for DST boundaries
      // * "LastEntry"  REG_DWORD "2038"
      //                           Last year in the table. If the current year is greater than this value,
      //                           this entry will be used for DST boundaries"
      // * "<year1>"    REG_BINARY REG_TZI_FORMAT
      // * "<year2>"    REG_BINARY REG_TZI_FORMAT
      // * "<year3>"    REG_BINARY REG_TZI_FORMAT
      //
      const dynamicKey = `${TimeZonesRegistryHive}\\${id}\\Dynamic DST`;
      if (!this._api.RegistryKeyExists(dynamicKey)) {
        const rule = TimeZoneInfoCachedData.CreateAdjustmentRuleFromTimeZoneInformation(
          defaultTimeZoneInformation, DateTime.MinValue.Date, DateTime.MaxValue.Date, defaultBaseUtcOffset);
        if (rule !== null) {
          rules = [rule];
        }
        return { Success: true, Rules: rules, Error: null };
      }

      //
      // loop over all of the "<time_zone_name>\Dynamic DST" hive entries
      //
      // read FirstEntry  {MinValue      - (year1, 12, 31)}
      // read MiddleEntry {(yearN, 1, 1) - (yearN, 12, 31)}
      // read LastEntry   {(yearN, 1, 1) - MaxValue       }

      // read the FirstEntry and LastEntry key values (ex: "1980", "2038")
      const first = this.GetIntValue(dynamicKey, FirstEntryValue, -1);
      const last = this.GetIntValue(dynamicKey, LastEntryValue, -1);

      if (first === -1 || last === -1 || first > last) {
        return { Success: false, Rules: null, Error: null };
      }

      // read the first year entry

      let dtzi = this.TryGetTimeZoneEntryFromRegistry(dynamicKey, String(first));
      if (dtzi === null) {
        return { Success: false, Rules: null, Error: null };
      }

      if (first === last) {
        // there is just 1 dynamic rule for this time zone.
        const rule = TimeZoneInfoCachedData.CreateAdjustmentRuleFromTimeZoneInformation(dtzi, DateTime.MinValue.Date, DateTime.MaxValue.Date, defaultBaseUtcOffset);
        if (rule !== null) {
          rules = [rule];
        }
        return { Success: true, Rules: rules, Error: null };
      }

      const rulesList: TimeZoneInfoAdjustmentRule[] = [];

      // there are more than 1 dynamic rules for this time zone.
      const firstRule = TimeZoneInfoCachedData.CreateAdjustmentRuleFromTimeZoneInformation(
        dtzi,
        DateTime.MinValue.Date, // MinValue
        DateTime.Create(first, 12, 31), // December 31, <FirstYear>
        defaultBaseUtcOffset);

      if (firstRule !== null) {
        rulesList.push(firstRule);
      }

      // read the middle year entries
      for (let i = first + 1; i < last; i++) {
        dtzi = this.TryGetTimeZoneEntryFromRegistry(dynamicKey, String(i));
        if (dtzi === null) {
          return { Success: false, Rules: null, Error: null };
        }
        const middleRule = TimeZoneInfoCachedData.CreateAdjustmentRuleFromTimeZoneInformation(
          dtzi,
          DateTime.Create(i, 1, 1), // January  01, <Year>
          DateTime.Create(i, 12, 31), // December 31, <Year>
          defaultBaseUtcOffset);

        if (middleRule !== null) {
          rulesList.push(middleRule);
        }
      }

      // read the last year entry
      dtzi = this.TryGetTimeZoneEntryFromRegistry(dynamicKey, String(last));
      if (dtzi === null) {
        return { Success: false, Rules: null, Error: null };
      }
      const lastRule = TimeZoneInfoCachedData.CreateAdjustmentRuleFromTimeZoneInformation(
        dtzi,
        DateTime.Create(last, 1, 1), // January  01, <LastYear>
        DateTime.MaxValue.Date, // MaxValue
        defaultBaseUtcOffset);

      if (lastRule !== null) {
        rulesList.push(lastRule);
      }

      // convert the List to an AdjustmentRule array
      if (rulesList.length !== 0) {
        rules = rulesList;
      }
    } catch (ex) {
      // one of the RegistryKey.GetValue calls could not be cast to an expected value type (InvalidCastException), or
      // the data is out of range (ArgumentOutOfRangeException, ArgumentException)
      if (IsNodaError(ex, "InvalidCastException") || IsNodaError(ex, "ArgumentException")) {
        return { Success: false, Rules: null, Error: ex };
      }
      throw ex;
    }
    return { Success: true, Rules: rules, Error: null };
  }

  /** (int)key.GetValue(name, defaultValue): a REG_DWORD, or the default if the value is missing. */
  private GetIntValue(keyPath: string, name: string, defaultValue: number): number {
    const value = this._api.GetRegistryValue(keyPath, name);
    if (value === null) {
      return defaultValue;
    }
    if (typeof value !== "number") {
      // The C# cast fails; TryCreateAdjustmentRules catches it.
      throw NewInvalidCastException("Unable to cast the registry value to System.Int32.");
    }
    return value | 0;
  }

  private TryGetTimeZoneEntryFromRegistry(keyPath: string, name: string): RegTziFormat | null {
    const regValue = this._api.GetRegistryValue(keyPath, name);
    if (!(regValue instanceof Uint8Array) || regValue.length !== RegTziFormatSize) {
      return null;
    }
    return ReadRegTziFormat(regValue);
  }

  /**
   * Helper function that compares the StandardBias and StandardDate portion a
   * TimeZoneInformation struct to a time zone registry entry.
   */
  private static TryCompareStandardDate(timeZone: TimeZoneInformation, registryTimeZoneInfo: RegTziFormat): boolean {
    return timeZone.Bias === registryTimeZoneInfo.Bias &&
      timeZone.StandardBias === registryTimeZoneInfo.StandardBias &&
      SystemTimeEquals(timeZone.StandardDate, registryTimeZoneInfo.StandardDate);
  }

  /**
   * Helper function that compares a TimeZoneInformation struct to a time zone registry entry.
   */
  private TryCompareTimeZoneInformationToRegistry(timeZone: TimeZoneInformation, id: string): { Result: boolean; DstDisabled: boolean } {
    const dstDisabled = false;

    const keyPath = `${TimeZonesRegistryHive}\\${id}`;
    if (!this._api.RegistryKeyExists(keyPath)) {
      return { Result: false, DstDisabled: dstDisabled };
    }

    const registryTimeZoneInfo = this.TryGetTimeZoneEntryFromRegistry(keyPath, TimeZoneInfoValue);
    if (registryTimeZoneInfo === null) {
      return { Result: false, DstDisabled: dstDisabled };
    }

    //
    // first compare the bias and standard date information between the data from the Win32 API
    // and the data from the registry...
    //
    let result = TimeZoneInfoCachedData.TryCompareStandardDate(timeZone, registryTimeZoneInfo);

    if (!result) {
      return { Result: false, DstDisabled: dstDisabled };
    }

    result = dstDisabled || TimeZoneInfoCachedData.CheckDaylightSavingTimeNotSupported(timeZone) ||
      //
      // since Daylight Saving Time is not "disabled", do a straight comparison between
      // the Win32 API data and the registry data ...
      //
      (timeZone.DaylightBias === registryTimeZoneInfo.DaylightBias &&
        SystemTimeEquals(timeZone.DaylightDate, registryTimeZoneInfo.DaylightDate));

    // Finally compare the "StandardName" string value...
    //
    // we do not compare "DaylightName" as this TimeZoneInformation field may contain
    // either "StandardName" or "DaylightName" depending on the time of year and current machine settings
    //
    if (result) {
      const registryStandardName = this.GetStringValue(keyPath, StandardValue);
      result = registryStandardName === timeZone.StandardName;
    }
    return { Result: result, DstDisabled: dstDisabled };
  }

  /** key.GetValue(name, string.Empty) as string: null if the value isn't a string. */
  private GetStringValue(keyPath: string, name: string): string | null {
    const value = this._api.GetRegistryValue(keyPath, name);
    return value === null ? "" : typeof value === "string" ? value : null;
  }

  /**
   * Try to find the time zone resources Dll matching the CurrentUICulture or one of its parent cultures.
   * We try to check of such resource module e.g. %windir%\system32\[UI Culture Name]\tzres.dll.mui exist.
   * If a localized resource file exists, we LoadString resource with the id specified inside resource input
   * string and and return it to our caller.
   */
  private GetLocalizedNameByMuiNativeResource(resource: string): string {
    if (resource === null || resource.length === 0) {
      return "";
    }

    // parse "@tzres.dll, -100"
    //
    // filePath   = "C:\Windows\System32\tzres.dll"
    // resourceId = -100
    //
    const resources = resource.split(",");
    if (resources.length !== 2) {
      return "";
    }

    // Get the resource ID (int.TryParse with NumberStyles.Integer: optional whitespace and sign)
    const idText = resources[1]!.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
    if (!/^[+-]?[0-9]+$/.test(idText) || Math.abs(Number(idText)) > 0x7fffffff) {
      return "";
    }
    const resourceId = -Number(idText);

    // Use the current UI culture when culture not specified
    let cultureName = this.GetCurrentUICultureName();

    // get the path to Windows\System32
    const system32 = this._api.GetSystemDirectory();

    // trim the string "@tzres.dll" to "tzres.dll" and append the "mui" file extension to it.
    const tzresDll = `${resources[0]!.replace(/^@+/, "")}.mui`;

    while (cultureName.length !== 0) {
      const filePath = JoinPath(JoinPath(system32, cultureName), tzresDll);
      if (this._api.FileExists(filePath)) {
        // Finally, get the resource from the resource path
        return this._api.LoadString(filePath, resourceId);
      }

      cultureName = ParentCultureName(cultureName);
    }

    return "";
  }

  /** CultureInfo.CurrentUICulture.Name on Windows: the user's first preferred UI language ("" if none). */
  private GetCurrentUICultureName(): string {
    return this._api.GetUserPreferredUILanguages()[0] ?? "";
  }

  /**
   * Helper function for retrieving the DisplayName, StandardName, and DaylightName from the registry
   *
   * The function first checks the MUI_ key-values, and if they exist, it loads the strings from the MUI
   * resource dll(s).  When the keys do not exist, the function falls back to reading from the standard
   * key-values
   */
  private GetLocalizedNamesByRegistryKey(keyPath: string): { DisplayName: string | null; StandardName: string | null; DaylightName: string | null } {
    let displayName: string | null = "";
    let standardName: string | null = "";
    let daylightName: string | null = "";

    // read the MUI_ registry keys
    const displayNameMuiResource = this.GetStringValue(keyPath, MuiDisplayValue);
    const standardNameMuiResource = this.GetStringValue(keyPath, MuiStandardValue);
    const daylightNameMuiResource = this.GetStringValue(keyPath, MuiDaylightValue);

    // try to load the strings from the native resource DLL(s)
    if (displayNameMuiResource !== null && displayNameMuiResource.length !== 0) {
      displayName = this.GetLocalizedNameByMuiNativeResource(displayNameMuiResource);
    }

    if (standardNameMuiResource !== null && standardNameMuiResource.length !== 0) {
      standardName = this.GetLocalizedNameByMuiNativeResource(standardNameMuiResource);
    }

    if (daylightNameMuiResource !== null && daylightNameMuiResource.length !== 0) {
      daylightName = this.GetLocalizedNameByMuiNativeResource(daylightNameMuiResource);
    }

    // fallback to using the standard registry keys
    if (displayName === null || displayName.length === 0) {
      displayName = this.GetStringValue(keyPath, DisplayValue);
    }
    if (standardName === null || standardName.length === 0) {
      standardName = this.GetStringValue(keyPath, StandardValue);
    }
    if (daylightName === null || daylightName.length === 0) {
      daylightName = this.GetStringValue(keyPath, DaylightValue);
    }
    return { DisplayName: displayName, StandardName: standardName, DaylightName: daylightName };
  }

  /**
   * Helper function that takes a string representing a time_zone_name registry key name
   * and returns a TimeZoneInfo instance.
   */
  private TryGetTimeZoneFromLocalMachine(id: string): { Result: TimeZoneInfoResult; Value: TimeZoneInfo | null; Error: Error | null } {
    // Standard Time Zone Registry Data
    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
    // HKLM
    //     Software
    //         Microsoft
    //             Windows NT
    //                 CurrentVersion
    //                     Time Zones
    //                         <time_zone_name>
    // * STD,         REG_SZ "Standard Time Name"
    //                       (For OS installed zones, this will always be English)
    // * MUI_STD,     REG_SZ "@tzres.dll,-1234"
    //                       Indirect string to localized resource for Standard Time,
    //                       add "%windir%\system32\" after "@"
    // * DLT,         REG_SZ "Daylight Time Name"
    //                       (For OS installed zones, this will always be English)
    // * MUI_DLT,     REG_SZ "@tzres.dll,-1234"
    //                       Indirect string to localized resource for Daylight Time,
    //                       add "%windir%\system32\" after "@"
    // * Display,     REG_SZ "Display Name like (GMT-8:00) Pacific Time..."
    // * MUI_Display, REG_SZ "@tzres.dll,-1234"
    //                       Indirect string to localized resource for the Display,
    //                       add "%windir%\system32\" after "@"
    // * TZI,         REG_BINARY REG_TZI_FORMAT
    //
    const keyPath = `${TimeZonesRegistryHive}\\${id}`;
    if (!this._api.RegistryKeyExists(keyPath)) {
      return { Result: TimeZoneInfoResult.TimeZoneNotFoundException, Value: null, Error: null };
    }

    const defaultTimeZoneInformation = this.TryGetTimeZoneEntryFromRegistry(keyPath, TimeZoneInfoValue);
    if (defaultTimeZoneInformation === null) {
      // the registry value could not be cast to a byte array
      return { Result: TimeZoneInfoResult.InvalidTimeZoneException, Value: null, Error: null };
    }

    const created = this.TryCreateAdjustmentRules(id, defaultTimeZoneInformation, defaultTimeZoneInformation.Bias);
    if (!created.Success) {
      return {
        Result: TimeZoneInfoResult.InvalidTimeZoneException,
        Value: null,
        Error: NewInvalidTimeZoneException(`The time zone ID '${id}' was found on the local computer, but the registry information was corrupt.`,
          created.Error === null ? undefined : { cause: created.Error }),
      };
    }

    const { DisplayName: displayName, StandardName: standardName, DaylightName: daylightName } = this.GetLocalizedNamesByRegistryKey(keyPath);

    try {
      const value = TimeZoneInfo.NewIdBaseUtcOffsetDisplayNameStandardDisplayNameDaylightDisplayNameAdjustmentRulesDisableDaylightSavingTimeHasIanaId(
        id,
        TimeSpanFromMinutes(-defaultTimeZoneInformation.Bias),
        displayName ?? "",
        standardName ?? "",
        daylightName ?? "",
        created.Rules,
        false);

      return { Result: TimeZoneInfoResult.Success, Value: value, Error: null };
    } catch (ex) {
      // TimeZoneInfo constructor can throw ArgumentException and InvalidTimeZoneException
      if (IsNodaError(ex, "ArgumentException") || IsNodaError(ex, "InvalidTimeZoneException")) {
        return { Result: TimeZoneInfoResult.InvalidTimeZoneException, Value: null, Error: ex };
      }
      throw ex;
    }
  }

  // Helper function to get the standard display name for the UTC static time zone instance
  private GetUtcStandardDisplayName(): string {
    // Don't bother looking up the name for invariant or English cultures
    const uiCultureName = this.GetCurrentUICultureName();
    if (uiCultureName.length === 0 || uiCultureName.split("-")[0]!.toLowerCase() === "en") {
      return InvariantUtcStandardDisplayName;
    }

    // Try to get a localized version of "Coordinated Universal Time" from the globalization data
    let standardDisplayName: string | null = null;
    const keyPath = `${TimeZonesRegistryHive}\\${UtcId}`;
    if (this._api.RegistryKeyExists(keyPath)) {
      // read the MUI_ registry key
      const standardNameMuiResource = this.GetStringValue(keyPath, MuiStandardValue);

      // try to load the string from the native resource DLL(s)
      if (standardNameMuiResource !== null && standardNameMuiResource.length !== 0) {
        standardDisplayName = this.GetLocalizedNameByMuiNativeResource(standardNameMuiResource);
      }

      // fallback to using the standard registry key
      if (standardDisplayName === null || standardDisplayName.length === 0) {
        standardDisplayName = this.GetStringValue(keyPath, StandardValue);
      }
    }

    // Final safety check.  Don't allow null or abbreviations
    if (standardDisplayName === null || standardDisplayName === "GMT" || standardDisplayName === "UTC") {
      standardDisplayName = InvariantUtcStandardDisplayName;
    }

    return standardDisplayName;
  }

  // Helper function to get the full display name for the UTC static time zone instance
  private static GetUtcFullDisplayName(_timeZoneId: string, standardDisplayName: string): string {
    return `(UTC) ${standardDisplayName}`;
  }

  // #endregion
}

/** string.CompareOrdinal: by UTF-16 code units. */
function CompareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Path.Join for two Windows path segments. */
function JoinPath(a: string, b: string): string {
  if (a.length === 0) {
    return b;
  }
  if (b.length === 0) {
    return a;
  }
  const separator = a.charAt(a.length - 1) === "\\" || a.charAt(a.length - 1) === "/" || b.charAt(0) === "\\" || b.charAt(0) === "/" ? "" : "\\";
  return a + separator + b;
}
