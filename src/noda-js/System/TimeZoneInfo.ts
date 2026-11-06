// noda-js: port of the parts of System.TimeZoneInfo that NodaTime's BclDateTimeZone uses, from dotnet/runtime
// (src/libraries/System.Private.CoreLib/src/System/TimeZoneInfo.cs): a zone's names, base offset and adjustment
// rules, and GetUtcOffset / IsDaylightSavingTime for a local (Unspecified) DateTime. Reading zones from Windows (the
// static members: Local, Utc, FindSystemTimeZoneById, GetSystemTimeZones) is in TimeZoneInfo.Win32.ts.
// Copyright (c) .NET Foundation and Contributors. Licensed under the MIT license (see NOTICE.txt).

import { NewArgumentException, NewArgumentOutOfRangeException, NewInvalidTimeZoneException } from "../internal.ts";
import type { SystemDateTimeZone } from "../internal.ts";
import { DateTime, TimeSpanTicks } from "./DateTime.ts";
import { TimeZoneInfoAdjustmentRule } from "./TimeZoneInfo.AdjustmentRule.ts";
import { TimeZoneInfoTransitionTime } from "./TimeZoneInfo.TransitionTime.ts";

const UtcId = "UTC";
const MaxOffset = 14 * TimeSpanTicks.PerHour;
const MinOffset = -14 * TimeSpanTicks.PerHour;

/** DaylightTime for a year: when daylight saving time starts and ends, as local times, and its delta. */
interface DaylightTimeStruct {
  readonly Start: DateTime;
  readonly End: DateTime;
  readonly Delta: number;
}

/**
 * A time zone as .NET's `System.TimeZoneInfo` represents it: names, a base UTC offset, and adjustment rules. noda-js
 * reads these from Windows (as .NET does) for `noda-js/system`; {@link SystemDateTimeZone.OriginalZone} gives the one a
 * zone was converted from.
 *
 * This type is immutable reference type.
 */
export class TimeZoneInfo {
  /** @internal TimeZoneInfo.AdjustmentRule. */
  static readonly AdjustmentRule = TimeZoneInfoAdjustmentRule;
  /** @internal TimeZoneInfo.TransitionTime. */
  static readonly TransitionTime = TimeZoneInfoTransitionTime;

  private readonly _id: string;
  /** TimeSpan ticks. */
  private readonly _baseUtcOffset: number;
  private readonly _displayName: string | null;
  private readonly _standardDisplayName: string | null;
  private readonly _daylightDisplayName: string | null;
  private readonly _supportsDaylightSavingTime: boolean;
  private readonly _adjustmentRules: readonly TimeZoneInfoAdjustmentRule[] | null;
  private readonly _hasIanaId: boolean;
  /** @internal The zones created for this one's alternative (IANA) IDs. */
  _equivalentZones: TimeZoneInfo[] | null = null;

  private constructor(
    id: string,
    baseUtcOffset: number,
    displayName: string | null,
    standardDisplayName: string | null,
    daylightDisplayName: string | null,
    adjustmentRules: readonly TimeZoneInfoAdjustmentRule[] | null,
    disableDaylightSavingTime: boolean,
    hasIanaId = false,
  ) {
    const adjustmentRulesSupportDst = TimeZoneInfo.ValidateTimeZoneInfo(id, baseUtcOffset, adjustmentRules);

    this._id = id;
    this._baseUtcOffset = baseUtcOffset;
    this._displayName = displayName;
    this._standardDisplayName = standardDisplayName;
    this._daylightDisplayName = disableDaylightSavingTime ? null : daylightDisplayName;
    this._supportsDaylightSavingTime = adjustmentRulesSupportDst && !disableDaylightSavingTime;
    this._adjustmentRules = adjustmentRules;

    this._hasIanaId = hasIanaId || id.toUpperCase() === UtcId;
  }

  /**
   * @internal The private constructor TimeZoneInfo(id, baseUtcOffset, displayName, standardDisplayName,
   * daylightDisplayName, adjustmentRules, disableDaylightSavingTime, hasIanaId).
   */
  static NewIdBaseUtcOffsetDisplayNameStandardDisplayNameDaylightDisplayNameAdjustmentRulesDisableDaylightSavingTimeHasIanaId(
    id: string,
    baseUtcOffset: number,
    displayName: string | null,
    standardDisplayName: string | null,
    daylightDisplayName: string | null,
    adjustmentRules: readonly TimeZoneInfoAdjustmentRule[] | null,
    disableDaylightSavingTime: boolean,
    hasIanaId = false,
  ): TimeZoneInfo {
    return new TimeZoneInfo(id, baseUtcOffset, displayName, standardDisplayName, daylightDisplayName, adjustmentRules, disableDaylightSavingTime, hasIanaId);
  }

  /** The time zone's identifier: on Windows, the registry key name (e.g. "AUS Eastern Standard Time"). */
  get Id(): string {
    return this._id;
  }

  /** Whether {@link TimeZoneInfo.Id} is an IANA ID (e.g. a zone found by an IANA ID on Windows). */
  get HasIanaId(): boolean {
    return this._hasIanaId;
  }

  /** The display name, e.g. "(UTC+10:00) Canberra, Melbourne, Sydney". */
  get DisplayName(): string {
    return this._displayName ?? "";
  }

  /** The name of the zone's standard time, e.g. "AUS Eastern Standard Time". */
  get StandardName(): string {
    return this._standardDisplayName ?? "";
  }

  /** The name of the zone's daylight saving time, e.g. "AUS Eastern Summer Time". */
  get DaylightName(): string {
    return this._daylightDisplayName ?? "";
  }

  /** @internal The base UTC offset, as TimeSpan ticks. */
  get BaseUtcOffset(): number {
    return this._baseUtcOffset;
  }

  /** Whether the zone has any daylight saving time rules. */
  get SupportsDaylightSavingTime(): boolean {
    return this._supportsDaylightSavingTime;
  }

  /** @internal Returns a copy of the adjustment rules. */
  GetAdjustmentRules(): TimeZoneInfoAdjustmentRule[] {
    return this._adjustmentRules === null ? [] : this._adjustmentRules.slice();
  }

  /** @internal The rules themselves (for the Windows code, which shares them between zones as .NET does). */
  get AdjustmentRulesOrNull(): readonly TimeZoneInfoAdjustmentRule[] | null {
    return this._adjustmentRules;
  }

  /**
   * @internal Returns the Universal Coordinated Time (UTC) Offset for a local time (DateTimeKind.Unspecified) in this
   * zone, as TimeSpan ticks. (Not ported: the Local and Utc kinds, which convert the time first.)
   */
  GetUtcOffset(dateTime: DateTime): number {
    return TimeZoneInfo.GetUtcOffsetForZone(dateTime, this);
  }

  /**
   * @internal Returns true if a local time (DateTimeKind.Unspecified) in this zone is during daylight saving time.
   * (Not ported: the Local and Utc kinds.)
   */
  IsDaylightSavingTime(dateTime: DateTime): boolean {
    //
    //    dateTime.Kind is UTC, then time will be converted from UTC
    //        into current instance's timezone
    //    dateTime.Kind is Local, then time will be converted from Local
    //        into current instance's timezone
    //    dateTime.Kind is UnSpecified, then time is already in
    //        current instance's timezone
    //
    // Our DateTime handles ambiguous times, (one is in the daylight and
    // one is in standard.) If a new DateTime is constructed during ambiguous
    // time, it is defaulted to "Standard" (i.e. this will return false).
    // For Invalid times, we will return false

    if (!this._supportsDaylightSavingTime || this._adjustmentRules === null) {
      return false;
    }

    const adjustedTime = dateTime;

    //
    // handle the normal cases...
    //
    const rule = this.GetAdjustmentRuleForTime(adjustedTime);
    if (rule !== null && rule.HasDaylightSaving) {
      const daylightTime = this.GetDaylightTime(adjustedTime.Year, rule);
      return TimeZoneInfo.GetIsDaylightSavings(adjustedTime, rule, daylightTime);
    } else {
      return false;
    }
  }

  /** Returns the {@link TimeZoneInfo.DisplayName}. */
  toString(): string {
    return this.DisplayName;
  }

  /** @internal TimeZoneInfo.CreateCustomTimeZone (a time zone with no daylight saving time). */
  static CreateCustomTimeZone(id: string, baseUtcOffset: number, displayName: string | null, standardDisplayName: string | null): TimeZoneInfo;
  /** @internal TimeZoneInfo.CreateCustomTimeZone. */
  static CreateCustomTimeZone(
    id: string,
    baseUtcOffset: number,
    displayName: string | null,
    standardDisplayName: string | null,
    daylightDisplayName: string | null,
    adjustmentRules: readonly TimeZoneInfoAdjustmentRule[] | null,
    disableDaylightSavingTime?: boolean,
  ): TimeZoneInfo;
  static CreateCustomTimeZone(
    id: string,
    baseUtcOffset: number,
    displayName: string | null,
    standardDisplayName: string | null,
    daylightDisplayName?: string | null,
    adjustmentRules?: readonly TimeZoneInfoAdjustmentRule[] | null,
    disableDaylightSavingTime = false,
  ): TimeZoneInfo {
    if (adjustmentRules === undefined) {
      // Not ported: hasIanaId from TryConvertIanaIdToWindowsId (it only affects HasIanaId).
      standardDisplayName ??= "";
      return new TimeZoneInfo(id, baseUtcOffset, displayName ?? "", standardDisplayName, standardDisplayName, null, false);
    }
    // Not ported: the copy of the rules (they're immutable here).
    return new TimeZoneInfo(id, baseUtcOffset, displayName ?? "", standardDisplayName ?? "", daylightDisplayName ?? "",
      adjustmentRules !== null && adjustmentRules.length > 0 ? adjustmentRules.slice() : null, disableDaylightSavingTime);
  }

  private GetAdjustmentRuleForTime(dateTime: DateTime): TimeZoneInfoAdjustmentRule | null {
    if (this._adjustmentRules === null || this._adjustmentRules.length === 0) {
      return null;
    }

    // Only check the whole-date portion of the dateTime for DateTimeKind.Unspecified rules -
    // This is because the AdjustmentRule DateStart & DateEnd are stored as
    // Date-only values {4/2/2006 - 10/28/2006} but actually represent the
    // time span {4/2/2006@00:00:00.00000 - 10/28/2006@23:59:59.99999}
    const date = dateTime.Date;

    let low = 0;
    let high = this._adjustmentRules.length - 1;

    while (low <= high) {
      const median = low + ((high - low) >> 1);

      const rule = this._adjustmentRules[median]!;

      const compareResult = TimeZoneInfo.CompareAdjustmentRuleToDateTime(rule, date);
      if (compareResult === 0) {
        return rule;
      } else if (compareResult < 0) {
        low = median + 1;
      } else {
        high = median - 1;
      }
    }

    return null;
  }

  /**
   * Determines if 'rule' is the correct AdjustmentRule for the given dateTime.
   * (Only the Unspecified DateStart and DateEnd of Windows rules are ported.)
   * @returns A value less than zero if rule is for times before dateTime. Zero if rule is correct for dateTime.
   * A value greater than zero if rule is for times after dateTime.
   */
  private static CompareAdjustmentRuleToDateTime(rule: TimeZoneInfoAdjustmentRule, dateOnly: DateTime): number {
    // if the rule's DateStart is Unspecified, then use the whole-date portion
    const isAfterStart = dateOnly.CompareTo(rule.DateStart) >= 0;

    if (!isAfterStart) {
      return 1;
    }

    // if the rule's DateEnd is Unspecified, then use the whole-date portion
    const isBeforeEnd = dateOnly.CompareTo(rule.DateEnd) <= 0;

    return isBeforeEnd ? 0 : -1;
  }

  /**
   * Helper function that returns a DaylightTime from a year and AdjustmentRule.
   */
  private GetDaylightTime(year: number, rule: TimeZoneInfoAdjustmentRule): DaylightTimeStruct {
    const delta = rule.DaylightDelta;
    // Not ported: NoDaylightTransitions rules (Unix only).
    const startTime = TimeZoneInfo.TransitionTimeToDateTime(year, rule.DaylightTransitionStart);
    const endTime = TimeZoneInfo.TransitionTimeToDateTime(year, rule.DaylightTransitionEnd);
    return { Start: startTime, End: endTime, Delta: delta };
  }

  /**
   * Helper function that checks if a given dateTime is in Daylight Saving Time (DST).
   * This function assumes the dateTime and AdjustmentRule are both in the same time zone.
   */
  private static GetIsDaylightSavings(time: DateTime, rule: TimeZoneInfoAdjustmentRule | null, daylightTime: DaylightTimeStruct): boolean {
    if (rule === null) {
      return false;
    }

    // Not ported: DateTimeKind.Local.

    // startTime and endTime represent the period from either the start of DST to the end and
    // ***does not include*** the potentially overlapped times
    //
    //         -=-=-=-=-=- Pacific Standard Time -=-=-=-=-=-=-
    //    April 2, 2006                            October 29, 2006
    // 2AM            3AM                        1AM              2AM
    // |      +1 hr     |                        |       -1 hr      |
    // | <invalid time> |                        | <ambiguous time> |
    //                  [========== DST ========>)
    //
    //        -=-=-=-=-=- Some Weird Time Zone -=-=-=-=-=-=-
    //    April 2, 2006                          October 29, 2006
    // 1AM              2AM                    2AM              3AM
    // |      -1 hr       |                      |       +1 hr      |
    // | <ambiguous time> |                      |  <invalid time>  |
    //                    [======== DST ========>)
    //
    const invalidAtStart = rule.DaylightDelta > 0;

    const startTime = rule.IsStartDateMarkerForBeginningOfYear()
      ? DateTime.Create(daylightTime.Start.Year, 1, 1)
      : daylightTime.Start.AddTicks(invalidAtStart ? rule.DaylightDelta : 0); /* FUTURE: - rule.StandardDelta; */

    const endTime = rule.IsEndDateMarkerForEndOfYear()
      ? DateTime.Create(daylightTime.End.Year + 1, 1, 1).AddTicks(-1)
      : daylightTime.End.AddTicks(invalidAtStart ? -rule.DaylightDelta : 0);

    return TimeZoneInfo.CheckIsDst(startTime, time, endTime, false, rule);
  }

  private static CheckIsDst(startTime: DateTime, time: DateTime, endTime: DateTime, ignoreYearAdjustment: boolean, rule: TimeZoneInfoAdjustmentRule): boolean {
    // NoDaylightTransitions AdjustmentRules should never get their year adjusted since they adjust the offset for the
    // entire time period - which may be for multiple years
    if (!ignoreYearAdjustment && !rule.NoDaylightTransitions) {
      const startTimeYear = startTime.Year;
      const endTimeYear = endTime.Year;

      if (startTimeYear !== endTimeYear) {
        endTime = endTime.AddYears(startTimeYear - endTimeYear);
      }

      const timeYear = time.Year;

      if (startTimeYear !== timeYear) {
        time = time.AddYears(startTimeYear - timeYear);
      }
    }

    if (startTime.CompareTo(endTime) > 0) {
      // In southern hemisphere, the daylight saving time starts later in the year, and ends in the beginning of next year.
      // Note, the summer in the southern hemisphere begins late in the year.
      return time.CompareTo(endTime) < 0 || time.CompareTo(startTime) >= 0;
    } else {
      // Not ported: NoDaylightTransitions (inclusive end).
      // In northern hemisphere, the daylight saving time starts in the middle of the year.
      return time.CompareTo(startTime) >= 0 && time.CompareTo(endTime) < 0;
    }
  }

  /**
   * Helper function that calculates the UTC offset for a dateTime in a timeZone.
   * This function assumes that the dateTime is already converted into the timeZone.
   */
  private static GetUtcOffsetForZone(time: DateTime, zone: TimeZoneInfo): number {
    let baseOffset = zone.BaseUtcOffset;
    const rule = zone.GetAdjustmentRuleForTime(time);

    if (rule !== null) {
      baseOffset += rule.BaseUtcOffsetDelta;
      if (rule.HasDaylightSaving) {
        const daylightTime = zone.GetDaylightTime(time.Year, rule);
        const isDaylightSavings = TimeZoneInfo.GetIsDaylightSavings(time, rule, daylightTime);
        baseOffset += isDaylightSavings ? rule.DaylightDelta : 0; /* FUTURE: rule.StandardDelta */
      }
    }

    return baseOffset;
  }

  /**
   * @internal Helper function that converts a year and TransitionTime into a DateTime.
   */
  static TransitionTimeToDateTime(year: number, transitionTime: TimeZoneInfoTransitionTime): DateTime {
    let value: DateTime;
    const timeOfDay = transitionTime.TimeOfDay.TimeOfDay;

    if (transitionTime.IsFixedDateRule) {
      // create a DateTime from the passed in year and the properties on the transitionTime

      let day = transitionTime.Day;
      // if the day is out of range for the month then use the last day of the month
      if (day > 28) {
        const daysInMonth = DateTime.DaysInMonth(year, transitionTime.Month);
        if (day > daysInMonth) {
          day = daysInMonth;
        }
      }

      value = DateTime.Create(year, transitionTime.Month, day).AddTicks(timeOfDay);
    } else {
      if (transitionTime.Week <= 4) {
        //
        // Get the (transitionTime.Week)th Sunday.
        //
        value = DateTime.Create(year, transitionTime.Month, 1).AddTicks(timeOfDay);

        const dayOfWeek = value.DayOfWeek;
        let delta = transitionTime.DayOfWeek - dayOfWeek;
        if (delta < 0) {
          delta += 7;
        }
        delta += 7 * (transitionTime.Week - 1);

        if (delta > 0) {
          value = value.AddDays(delta);
        }
      } else {
        //
        // If TransitionWeek is greater than 4, we will get the last week.
        //
        const daysInMonth = DateTime.DaysInMonth(year, transitionTime.Month);
        value = DateTime.Create(year, transitionTime.Month, daysInMonth).AddTicks(timeOfDay);

        // This is the day of week for the last day of the month.
        const dayOfWeek = value.DayOfWeek;
        let delta = dayOfWeek - transitionTime.DayOfWeek;
        if (delta < 0) {
          delta += 7;
        }

        if (delta > 0) {
          value = value.AddDays(-delta);
        }
      }
    }
    return value;
  }

  /**
   * Helper function that performs all of the validation checks for the
   * factory methods and deserialization callback.
   * @returns adjustmentRulesSupportDst
   */
  private static ValidateTimeZoneInfo(id: string, baseUtcOffset: number, adjustmentRules: readonly TimeZoneInfoAdjustmentRule[] | null): boolean {
    if (id === null || id === undefined || id.length === 0) {
      throw NewArgumentException("The value cannot be an empty string.", "id");
    }

    if (TimeZoneInfo.UtcOffsetOutOfRange(baseUtcOffset)) {
      throw NewArgumentOutOfRangeException("baseUtcOffset", undefined, "The TimeSpan parameter must be within plus or minus 14.0 hours.");
    }

    if (baseUtcOffset % TimeSpanTicks.PerMinute !== 0) {
      throw NewArgumentException("The TimeSpan parameter cannot be specified more precisely than whole minutes.", "baseUtcOffset");
    }

    let adjustmentRulesSupportDst = false;

    //
    // "adjustmentRules" can either be null or a valid array of AdjustmentRule objects.
    // A valid array is one that does not contain any null elements and all elements
    // are sorted in chronological order
    //

    if (adjustmentRules !== null && adjustmentRules.length !== 0) {
      adjustmentRulesSupportDst = true;
      let current: TimeZoneInfoAdjustmentRule | null = null;
      for (let i = 0; i < adjustmentRules.length; i++) {
        const prev = current;
        current = adjustmentRules[i]!;

        if (!TimeZoneInfo.IsValidAdjustmentRuleOffset(baseUtcOffset, current)) {
          throw NewInvalidTimeZoneException("The sum of the BaseUtcOffset and DaylightDelta properties must within plus or minus 14.0 hours.");
        }

        if (prev !== null && current.DateStart.CompareTo(prev.DateEnd) <= 0) {
          // verify the rules are in chronological order and the DateStart/DateEnd do not overlap
          throw NewInvalidTimeZoneException("The elements of the AdjustmentRule array must be in chronological order and must not overlap.");
        }
      }
    }
    return adjustmentRulesSupportDst;
  }

  /**
   * Helper function that validates the TimeSpan is within +/- 14.0 hours
   */
  private static UtcOffsetOutOfRange(offset: number): boolean {
    return offset < MinOffset || offset > MaxOffset;
  }

  private static GetUtcOffsetForRule(baseUtcOffset: number, adjustmentRule: TimeZoneInfoAdjustmentRule): number {
    return baseUtcOffset +
      adjustmentRule.BaseUtcOffsetDelta +
      (adjustmentRule.HasDaylightSaving ? adjustmentRule.DaylightDelta : 0);
  }

  /**
   * Helper function that performs adjustment rule validation
   */
  private static IsValidAdjustmentRuleOffset(baseUtcOffset: number, adjustmentRule: TimeZoneInfoAdjustmentRule): boolean {
    const utcOffset = TimeZoneInfo.GetUtcOffsetForRule(baseUtcOffset, adjustmentRule);
    return !TimeZoneInfo.UtcOffsetOutOfRange(utcOffset);
  }
}
