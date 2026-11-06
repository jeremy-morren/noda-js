// noda-js: port of System.TimeZoneInfo.TransitionTime from dotnet/runtime
// (src/libraries/System.Private.CoreLib/src/System/TimeZoneInfo.TransitionTime.cs).
// Copyright (c) .NET Foundation and Contributors. Licensed under the MIT license (see NOTICE.txt).

import { NewArgumentException, NewArgumentOutOfRangeException } from "../internal.ts";
import { DateTime, TimeSpanTicks } from "./DateTime.ts";

/**
 * When a daylight saving time rule starts or ends: a fixed date ("1 January") or a floating one ("the last Sunday in
 * October"), at a time of day. A port of .NET's `TimeZoneInfo.TransitionTime`.
 *
 * This type is an immutable value type.
 */
export class TimeZoneInfoTransitionTime {
  private constructor(
    private readonly _timeOfDay: DateTime,
    private readonly _month: number,
    private readonly _week: number,
    private readonly _day: number,
    private readonly _dayOfWeek: number,
    private readonly _isFixedDateRule: boolean,
  ) {}

  /** @internal The time of day of the transition: a DateTime on 0001-01-01. */
  get TimeOfDay(): DateTime {
    return this._timeOfDay;
  }

  /** The month of the transition, 1-12 (0 for the default value). */
  get Month(): number {
    return this._month;
  }

  /** For a floating rule, the week of the month, 1-5 (5: the last). */
  get Week(): number {
    return this._week;
  }

  /** For a fixed rule, the day of the month. */
  get Day(): number {
    return this._day;
  }

  /** For a floating rule, the day of the week (System.DayOfWeek: 0 for Sunday to 6 for Saturday). */
  get DayOfWeek(): number {
    return this._dayOfWeek;
  }

  /** Whether the transition is on a fixed date (rather than a floating one). */
  get IsFixedDateRule(): boolean {
    return this._isFixedDateRule;
  }

  /** @internal default(TransitionTime): every field zero. */
  static readonly Default: TimeZoneInfoTransitionTime = new TimeZoneInfoTransitionTime(DateTime.MinValue, 0, 0, 0, 0, false);

  /** Whether this is the same transition as another. */
  Equals(other: TimeZoneInfoTransitionTime): boolean {
    return this._isFixedDateRule === other._isFixedDateRule &&
      this._timeOfDay.Equals(other._timeOfDay) &&
      this._month === other._month &&
      (other._isFixedDateRule
        ? this._day === other._day
        : this._week === other._week && this._dayOfWeek === other._dayOfWeek);
  }

  /** @internal TransitionTime.CreateFixedDateRule. */
  static CreateFixedDateRule(timeOfDay: DateTime, month: number, day: number): TimeZoneInfoTransitionTime {
    return TimeZoneInfoTransitionTime.Create(timeOfDay, month, 1, day, 0, true);
  }

  /** @internal TransitionTime.CreateFloatingDateRule. */
  static CreateFloatingDateRule(timeOfDay: DateTime, month: number, week: number, dayOfWeek: number): TimeZoneInfoTransitionTime {
    return TimeZoneInfoTransitionTime.Create(timeOfDay, month, week, 1, dayOfWeek, false);
  }

  private static Create(timeOfDay: DateTime, month: number, week: number, day: number, dayOfWeek: number, isFixedDateRule: boolean): TimeZoneInfoTransitionTime {
    TimeZoneInfoTransitionTime.ValidateTransitionTime(timeOfDay, month, week, day, dayOfWeek);
    return new TimeZoneInfoTransitionTime(timeOfDay, month, week, day, dayOfWeek, isFixedDateRule);
  }

  private static ValidateTransitionTime(timeOfDay: DateTime, month: number, week: number, day: number, dayOfWeek: number): void {
    // Not ported: the DateTimeKind check (every DateTime here is Unspecified).

    // Month range 1-12
    if (month < 1 || month > 12) {
      throw NewArgumentOutOfRangeException("month", undefined, "Month must be between one and twelve.");
    }

    // Day range 1-31
    if (day < 1 || day > 31) {
      throw NewArgumentOutOfRangeException("day", undefined, "Day must be between 1 and 31.");
    }

    // Week range 1-5
    if (week < 1 || week > 5) {
      throw NewArgumentOutOfRangeException("week", undefined, "The Week parameter must be in the range 1 through 5.");
    }

    // DayOfWeek range 0-6
    if (dayOfWeek < 0 || dayOfWeek > 6) {
      throw NewArgumentOutOfRangeException("dayOfWeek", undefined, "The DayOfWeek enumeration must be in the range 0 through 6.");
    }

    if (timeOfDay.Days !== 0 || timeOfDay.TickOfDay % TimeSpanTicks.PerMillisecond !== 0) {
      throw NewArgumentException("The supplied DateTime must have the Year, Month, and Day properties set to 1.  The time cannot be specified more precisely than whole milliseconds.", "timeOfDay");
    }
  }
}
