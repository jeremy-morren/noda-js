// noda-js: port of the parts of System.DateTime and System.TimeSpan that System/TimeZoneInfo.ts uses, from
// dotnet/runtime (src/libraries/System.Private.CoreLib/src/System/DateTime.cs, TimeSpan.cs).
// Copyright (c) .NET Foundation and Contributors. Licensed under the MIT license (see NOTICE.txt).
//
// A DateTime is a count of 100ns ticks since 0001-01-01T00:00:00 in the proleptic Gregorian calendar. JavaScript
// numbers can't hold every tick count exactly (they go up to 3.2e18), so this DateTime keeps whole days and the tick
// of the day separately. Only the Unspecified kind is represented: the Windows time zone data is all local times
// (System.TimeZoneInfo's rules on Windows never have the Utc kind). A TimeSpan is a plain number of ticks (time zone
// offsets and deltas are far within 2^53 ticks).

import { NewArgumentOutOfRangeException } from "../internal.ts";

/** @internal TimeSpan.TicksPerMillisecond and friends. */
export const TimeSpanTicks = {
  PerMillisecond: 10_000,
  PerSecond: 10_000_000,
  PerMinute: 600_000_000,
  PerHour: 36_000_000_000,
  PerDay: 864_000_000_000,
} as const;

/** @internal new TimeSpan(0, minutes, 0), as ticks. */
export function TimeSpanFromMinutes(minutes: number): number {
  // (+ 0: never -0, from -bias with a bias of 0.)
  return minutes * TimeSpanTicks.PerMinute + 0;
}

const DaysToMonth365 = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
const DaysToMonth366 = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];
/** Days from 0001-01-01 to 10000-01-01. */
const DaysTo10000 = 3652059;

function IsLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Days from 0001-01-01 to the start of the given date. */
function DateToDays(year: number, month: number, day: number): number {
  const days = IsLeapYear(year) ? DaysToMonth366 : DaysToMonth365;
  const y = year - 1;
  return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + days[month - 1]! + day - 1;
}

/**
 * @internal System.DateTime (Unspecified kind only), to tick precision.
 */
export class DateTime {
  private constructor(
    /** Whole days since 0001-01-01. */
    readonly Days: number,
    /** Ticks since the start of the day, [0, TicksPerDay). */
    readonly TickOfDay: number,
  ) {}

  /** new DateTime(year, month, day[, hour, minute, second, millisecond]), validated as .NET does. */
  static Create(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millisecond = 0): DateTime {
    if (year < 1 || year > 9999 || month < 1 || month > 12) {
      throw NewArgumentOutOfRangeException(null, null, "Year, Month, and Day parameters describe an un-representable DateTime.");
    }
    if (day < 1 || day > DateTime.DaysInMonth(year, month)) {
      throw NewArgumentOutOfRangeException(null, null, "Year, Month, and Day parameters describe an un-representable DateTime.");
    }
    if (hour < 0 || hour >= 24 || minute < 0 || minute >= 60 || second < 0 || second >= 60) {
      throw NewArgumentOutOfRangeException(null, null, "Hour, Minute, and Second parameters describe an un-representable DateTime.");
    }
    if (millisecond < 0 || millisecond >= 1000) {
      throw NewArgumentOutOfRangeException("millisecond", millisecond, "Valid values are between 0 and 999, inclusive.");
    }
    const tickOfDay = hour * TimeSpanTicks.PerHour + minute * TimeSpanTicks.PerMinute + second * TimeSpanTicks.PerSecond +
      millisecond * TimeSpanTicks.PerMillisecond;
    return new DateTime(DateToDays(year, month, day), tickOfDay);
  }

  /** DateTime.MinValue: 0001-01-01T00:00:00. */
  static readonly MinValue: DateTime = new DateTime(0, 0);

  /** DateTime.MaxValue: 9999-12-31T23:59:59.9999999. */
  static readonly MaxValue: DateTime = new DateTime(DaysTo10000 - 1, TimeSpanTicks.PerDay - 1);

  static DaysInMonth(year: number, month: number): number {
    const days = IsLeapYear(year) ? DaysToMonth366 : DaysToMonth365;
    return days[month]! - days[month - 1]!;
  }

  /** The date part: midnight on the same day. */
  get Date(): DateTime {
    return new DateTime(this.Days, 0);
  }

  /** The time of day, as TimeSpan ticks. */
  get TimeOfDay(): number {
    return this.TickOfDay;
  }

  get Year(): number {
    return this.GetDatePart().Year;
  }

  get Month(): number {
    return this.GetDatePart().Month;
  }

  get Day(): number {
    return this.GetDatePart().Day;
  }

  get Hour(): number {
    return Math.floor(this.TickOfDay / TimeSpanTicks.PerHour);
  }

  get Minute(): number {
    return Math.floor(this.TickOfDay / TimeSpanTicks.PerMinute) % 60;
  }

  get Second(): number {
    return Math.floor(this.TickOfDay / TimeSpanTicks.PerSecond) % 60;
  }

  get Millisecond(): number {
    return Math.floor(this.TickOfDay / TimeSpanTicks.PerMillisecond) % 1000;
  }

  /** The ticks within the millisecond, [0, 10000). */
  get SubMillisecondTicks(): number {
    return this.TickOfDay % TimeSpanTicks.PerMillisecond;
  }

  /** System.DayOfWeek: 0 (Sunday) to 6 (Saturday). 0001-01-01 was a Monday. */
  get DayOfWeek(): number {
    return (this.Days + 1) % 7;
  }

  /** dateTime + timeSpan, or AddTicks; throws ArgumentOutOfRangeException outside [MinValue, MaxValue]. */
  AddTicks(ticks: number): DateTime {
    const total = this.TickOfDay + ticks;
    const dayDelta = Math.floor(total / TimeSpanTicks.PerDay);
    const days = this.Days + dayDelta;
    if (days < 0 || days >= DaysTo10000) {
      throw NewArgumentOutOfRangeException("value", null, "The added or subtracted value results in an un-representable DateTime.");
    }
    return new DateTime(days, total - dayDelta * TimeSpanTicks.PerDay);
  }

  AddMilliseconds(milliseconds: number): DateTime {
    return this.AddTicks(milliseconds * TimeSpanTicks.PerMillisecond);
  }

  AddDays(days: number): DateTime {
    return this.AddTicks(days * TimeSpanTicks.PerDay);
  }

  /** DateTime.AddYears: the same month and day (the 28th for 29 February in a common year), and time of day. */
  AddYears(years: number): DateTime {
    const { Year, Month, Day } = this.GetDatePart();
    const year = Year + years;
    if (year < 1 || year > 9999) {
      throw NewArgumentOutOfRangeException("years", years, "The added or subtracted value results in an un-representable DateTime.");
    }
    const day = Math.min(Day, DateTime.DaysInMonth(year, Month));
    return new DateTime(DateToDays(year, Month, day), this.TickOfDay);
  }

  /** Compares two values: negative, zero or positive. */
  CompareTo(other: DateTime): number {
    return this.Days !== other.Days ? this.Days - other.Days : this.TickOfDay - other.TickOfDay;
  }

  Equals(other: DateTime): boolean {
    return this.Days === other.Days && this.TickOfDay === other.TickOfDay;
  }

  /** "yyyy-MM-ddTHH:mm:ss.fffffff", for messages and tests. */
  toString(): string {
    const { Year, Month, Day } = this.GetDatePart();
    const pad = (value: number, length: number): string => {
      let text = String(value);
      while (text.length < length) {
        text = "0" + text;
      }
      return text;
    };
    return `${pad(Year, 4)}-${pad(Month, 2)}-${pad(Day, 2)}T${pad(this.Hour, 2)}:${pad(this.Minute, 2)}:${pad(this.Second, 2)}.` +
      pad(this.TickOfDay % TimeSpanTicks.PerSecond, 7);
  }

  private GetDatePart(): { Year: number; Month: number; Day: number } {
    // DateTime.GetDate: 400-, 100-, 4- and 1-year cycles.
    let n = this.Days;
    const y400 = Math.floor(n / 146097);
    n -= y400 * 146097;
    let y100 = Math.floor(n / 36524);
    if (y100 === 4) {
      y100 = 3;
    }
    n -= y100 * 36524;
    const y4 = Math.floor(n / 1461);
    n -= y4 * 1461;
    let y1 = Math.floor(n / 365);
    if (y1 === 4) {
      y1 = 3;
    }
    n -= y1 * 365;
    const year = y400 * 400 + y100 * 100 + y4 * 4 + y1 + 1;
    const days = IsLeapYear(year) ? DaysToMonth366 : DaysToMonth365;
    let month = 1;
    while (n >= days[month]!) {
      month++;
    }
    return { Year: year, Month: month, Day: n - days[month - 1]! + 1 };
  }
}
