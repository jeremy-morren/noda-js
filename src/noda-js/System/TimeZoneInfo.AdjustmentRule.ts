// noda-js: port of System.TimeZoneInfo.AdjustmentRule from dotnet/runtime
// (src/libraries/System.Private.CoreLib/src/System/TimeZoneInfo.AdjustmentRule.cs).
// Copyright (c) .NET Foundation and Contributors. Licensed under the MIT license (see NOTICE.txt).

import { NewArgumentException, NewArgumentOutOfRangeException } from "../internal.ts";
import { DateTime, TimeSpanTicks } from "./DateTime.ts";
import { TimeZoneInfoTransitionTime } from "./TimeZoneInfo.TransitionTime.ts";

const DaylightDeltaAdjustment = 24 * TimeSpanTicks.PerHour;
const MaxDaylightDelta = 12 * TimeSpanTicks.PerHour;

/**
 * A period (whole days, from DateStart to DateEnd inclusive) during which a time zone has the same rules: its standard
 * offset (relative to the zone's base offset), and when daylight saving time starts and ends. A port of .NET's
 * `TimeZoneInfo.AdjustmentRule`.
 *
 * Only rules as .NET creates them on Windows are represented: the Unix-only kind with no daylight transitions
 * (NoDaylightTransitions) isn't ported.
 *
 * This type is immutable reference type.
 */
export class TimeZoneInfoAdjustmentRule {
  private constructor(
    private readonly _dateStart: DateTime,
    private readonly _dateEnd: DateTime,
    /** TimeSpan ticks. */
    private readonly _daylightDelta: number,
    private readonly _daylightTransitionStart: TimeZoneInfoTransitionTime,
    private readonly _daylightTransitionEnd: TimeZoneInfoTransitionTime,
    /** TimeSpan ticks: delta from the default Utc offset (utcOffset = defaultUtcOffset + _baseUtcOffsetDelta). */
    private readonly _baseUtcOffsetDelta: number,
  ) {
    TimeZoneInfoAdjustmentRule.ValidateAdjustmentRule(_dateStart, _dateEnd, _daylightDelta, _daylightTransitionStart, _daylightTransitionEnd);
  }

  /** @internal The first day of the rule. */
  get DateStart(): DateTime {
    return this._dateStart;
  }

  /** @internal The last day of the rule. */
  get DateEnd(): DateTime {
    return this._dateEnd;
  }

  /** @internal The daylight saving, as TimeSpan ticks. */
  get DaylightDelta(): number {
    return this._daylightDelta;
  }

  /** When daylight saving time starts each year. */
  get DaylightTransitionStart(): TimeZoneInfoTransitionTime {
    return this._daylightTransitionStart;
  }

  /** When daylight saving time ends each year. */
  get DaylightTransitionEnd(): TimeZoneInfoTransitionTime {
    return this._daylightTransitionEnd;
  }

  /** @internal The rule's standard offset relative to the zone's base offset, as TimeSpan ticks. */
  get BaseUtcOffsetDelta(): number {
    return this._baseUtcOffsetDelta;
  }

  /** @internal */
  get NoDaylightTransitions(): boolean {
    return false;
  }

  /** @internal */
  get HasDaylightSaving(): boolean {
    return this.DaylightDelta !== 0 ||
      (!this.DaylightTransitionStart.Equals(TimeZoneInfoTransitionTime.Default) && !this.DaylightTransitionStart.TimeOfDay.Equals(DateTime.MinValue)) ||
      (!this.DaylightTransitionEnd.Equals(TimeZoneInfoTransitionTime.Default) && !this.DaylightTransitionEnd.TimeOfDay.Equals(DateTime.MinValue.AddMilliseconds(1)));
  }

  /** Whether this rule is the same as another. */
  Equals(other: TimeZoneInfoAdjustmentRule | null): boolean {
    return other !== null &&
      this._dateStart.Equals(other._dateStart) &&
      this._dateEnd.Equals(other._dateEnd) &&
      this._daylightDelta === other._daylightDelta &&
      this._baseUtcOffsetDelta === other._baseUtcOffsetDelta &&
      this._daylightTransitionEnd.Equals(other._daylightTransitionEnd) &&
      this._daylightTransitionStart.Equals(other._daylightTransitionStart);
  }

  /**
   * @internal AdjustmentRule.CreateAdjustmentRule (with the internal overload's adjustment of daylight deltas beyond
   * ±12 hours into the base offset delta).
   */
  static CreateAdjustmentRule(
    dateStart: DateTime,
    dateEnd: DateTime,
    daylightDelta: number,
    daylightTransitionStart: TimeZoneInfoTransitionTime,
    daylightTransitionEnd: TimeZoneInfoTransitionTime,
    baseUtcOffsetDelta = 0,
  ): TimeZoneInfoAdjustmentRule {
    [daylightDelta, baseUtcOffsetDelta] = TimeZoneInfoAdjustmentRule.AdjustDaylightDeltaToExpectedRange(daylightDelta, baseUtcOffsetDelta);
    return new TimeZoneInfoAdjustmentRule(dateStart, dateEnd, daylightDelta, daylightTransitionStart, daylightTransitionEnd, baseUtcOffsetDelta);
  }

  //
  // When Windows sets the daylight transition start Jan 1st at 12:00 AM, it means the year starts with the daylight saving on.
  // We have to special case this value and not adjust it when checking if any date is in the daylight saving period.
  //
  /** @internal */
  IsStartDateMarkerForBeginningOfYear(): boolean {
    return !this.NoDaylightTransitions &&
      this.DaylightTransitionStart.Month === 1 && this.DaylightTransitionStart.Day === 1 &&
      this.DaylightTransitionStart.TimeOfDay.TimeOfDay < TimeSpanTicks.PerSecond; // < 12:00:01 AM
  }

  //
  // When Windows sets the daylight transition end Jan 1st at 12:00 AM, it means the year ends with the daylight saving on.
  // We have to special case this value and not adjust it when checking if any date is in the daylight saving period.
  //
  /** @internal */
  IsEndDateMarkerForEndOfYear(): boolean {
    return !this.NoDaylightTransitions &&
      this.DaylightTransitionEnd.Month === 1 && this.DaylightTransitionEnd.Day === 1 &&
      this.DaylightTransitionEnd.TimeOfDay.TimeOfDay < TimeSpanTicks.PerSecond; // < 12:00:01 AM
  }

  private static ValidateAdjustmentRule(
    dateStart: DateTime,
    dateEnd: DateTime,
    daylightDelta: number,
    daylightTransitionStart: TimeZoneInfoTransitionTime,
    daylightTransitionEnd: TimeZoneInfoTransitionTime,
  ): void {
    // Not ported: the DateTimeKind checks (every DateTime here is Unspecified).

    if (daylightTransitionStart.Equals(daylightTransitionEnd)) {
      throw NewArgumentException("The DateTime parameters for the TransitionTime objects must not be identical.", "daylightTransitionEnd");
    }

    if (dateStart.CompareTo(dateEnd) > 0) {
      throw NewArgumentException("The DateStart property must come before the DateEnd property.", "dateStart");
    }

    // This cannot use UtcOffsetOutOfRange to account for the scenario where Samoa moved across the International Date Line,
    // which caused their current BaseUtcOffset to be +13. But on the other side of the line it was UTC-11 (+1 for daylight).
    // So when trying to describe DaylightDeltas for those times, the DaylightDelta needs
    // to be -23 (what it takes to go from UTC+13 to UTC-10)
    if (daylightDelta < -23 * TimeSpanTicks.PerHour || daylightDelta > 14 * TimeSpanTicks.PerHour) {
      throw NewArgumentOutOfRangeException("daylightDelta", daylightDelta, "The TimeSpan parameter must be within plus or minus 14.0 hours.");
    }

    if (daylightDelta % TimeSpanTicks.PerMinute !== 0) {
      throw NewArgumentException("The TimeSpan parameter cannot be specified more precisely than whole minutes.", "daylightDelta");
    }

    if (!dateStart.Equals(DateTime.MinValue) && dateStart.TimeOfDay !== 0) {
      throw NewArgumentException("The supplied DateTime includes a TimeOfDay setting.   This is not supported.", "dateStart");
    }

    if (!dateEnd.Equals(DateTime.MaxValue) && dateEnd.TimeOfDay !== 0) {
      throw NewArgumentException("The supplied DateTime includes a TimeOfDay setting.   This is not supported.", "dateEnd");
    }
  }

  private static AdjustDaylightDeltaToExpectedRange(daylightDelta: number, baseUtcOffsetDelta: number): [number, number] {
    if (daylightDelta > MaxDaylightDelta) {
      daylightDelta -= DaylightDeltaAdjustment;
      baseUtcOffsetDelta += DaylightDeltaAdjustment;
    } else if (daylightDelta < -MaxDaylightDelta) {
      daylightDelta += DaylightDeltaAdjustment;
      baseUtcOffsetDelta -= DaylightDeltaAdjustment;
    }
    return [daylightDelta, baseUtcOffsetDelta];
  }
}
