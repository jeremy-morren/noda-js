// Ported from NodaTime 3.3.7: src/NodaTime/TimeZones/BclDateTimeZone.cs
// Copyright 2012 The Noda Time Authors. All rights reserved.
// Use of this source code is governed by the Apache License 2.0,
// as found in the LICENSE.txt file.
//
// noda-js: BclDateTimeZone is SystemDateTimeZone (its zones are the host system's). Its TimeZoneInfo is noda-js's port
// of .NET's (src/noda-js/System/), read from Windows' registry as .NET does. Where the host can't read Windows' data,
// zones come from Intl instead (FromIntl, a noda-js addition; the probing is in System/IntlTimeZone.ts).

import {
  CachingZoneIntervalMap,
  DateTimeZone,
  DateTimeZoneNotFoundException,
  GetTimeZoneInfoSystemDefaultId,
  Instant,
  Int32,
  IsoDayOfWeek,
  LocalDateTime,
  LocalTime,
  NewInvalidOperationException,
  Offset,
  PartialZoneIntervalMap,
  Preconditions,
  SingleZoneIntervalMap,
  StandardDaylightAlternatingMap,
  TimeZoneInfoInterceptor,
  TransitionMode,
  ZoneInterval,
  ZoneRecurrence,
  ZoneYearOffset,
} from "../internal.ts";
import type { IDateTimeZoneProvider, InvalidOperationException, ITimeZoneInfoShim, IZoneIntervalMap, SystemDateTimeZoneSource } from "../internal.ts";
import { GetTZEnvironmentVariable } from "../Utility/TimeZoneEnvironment.ts";
import { DateTime, TimeSpanTicks } from "../System/DateTime.ts";
import type { TimeZoneInfo } from "../System/TimeZoneInfo.ts";
import type { TimeZoneInfoAdjustmentRule } from "../System/TimeZoneInfo.AdjustmentRule.ts";
import type { TimeZoneInfoTransitionTime } from "../System/TimeZoneInfo.TransitionTime.ts";
import { CreateIntlZoneIntervalMap, GetIntlGenericName } from "../System/IntlTimeZone.ts";
import { IntlSystemTimeZones } from "../System/IntlSystemTimeZones.ts";

// #region BCL conversions (NodaTime's BclConversions and extension methods, for noda-js's DateTime and TimeSpan)

/** TimeSpan.ToOffset(): a TimeSpan (ticks) as an Offset. */
function ToOffset(timeSpanTicks: number): Offset {
  return Offset.FromTicks(timeSpanTicks);
}

/** DateTime.ToLocalDateTime() / LocalDateTime.FromDateTime. */
function ToLocalDateTime(dateTime: DateTime): LocalDateTime {
  return new LocalDateTime(dateTime.Year, dateTime.Month, dateTime.Day, dateTime.Hour, dateTime.Minute, dateTime.Second, dateTime.Millisecond)
    .PlusTicks(dateTime.SubMillisecondTicks);
}

/** BclConversions.ToIsoDayOfWeek(DayOfWeek). */
function ToIsoDayOfWeek(dayOfWeek: number): IsoDayOfWeek {
  return dayOfWeek === 0 ? IsoDayOfWeek.Sunday : (dayOfWeek as IsoDayOfWeek);
}

// #endregion

/**
 * This is used to cache the last result of a call to {@link SystemDateTimeZone.ForSystemDefault}, but it doesn't
 * matter if it's out of date - we'll just create another wrapper if necessary. It's not *that* expensive to make
 * a few more wrappers than we need.
 */
let systemDefault: SystemDateTimeZone | null = null;

const MaxDate = DateTime.MaxValue.Date;

/**
 * Just a mapping of a TimeZoneInfo.AdjustmentRule into Noda Time types. Very little cleverness here.
 * @internal
 */
export class SystemDateTimeZoneBclAdjustmentRule {
  /**
   * Instant on which this rule starts.
   */
  get Start(): Instant {
    return this.PartialMap.Start;
  }

  /**
   * Instant on which this rule ends.
   */
  get End(): Instant {
    return this.PartialMap.End;
  }

  /**
   * Daylight savings, when applicable within this rule.
   */
  readonly Savings: Offset;

  /**
   * The standard offset for the duration of this rule.
   */
  readonly StandardOffset: Offset;

  readonly PartialMap: PartialZoneIntervalMap;

  private constructor(standardOffset: Offset, savings: Offset, partialMap: PartialZoneIntervalMap) {
    this.StandardOffset = standardOffset;
    this.Savings = savings;
    this.PartialMap = partialMap;
  }

  // Visible for tests
  static NewZoneInterval(zoneInterval: ZoneInterval): SystemDateTimeZoneBclAdjustmentRule {
    return new SystemDateTimeZoneBclAdjustmentRule(zoneInterval.StandardOffset, zoneInterval.Savings, PartialZoneIntervalMap.ForZoneInterval(zoneInterval));
  }

  WithStart(newStart: Instant): SystemDateTimeZoneBclAdjustmentRule {
    return new SystemDateTimeZoneBclAdjustmentRule(this.StandardOffset, this.Savings, this.PartialMap.WithStart(newStart));
  }

  WithEnd(newEnd: Instant): SystemDateTimeZoneBclAdjustmentRule {
    return new SystemDateTimeZoneBclAdjustmentRule(this.StandardOffset, this.Savings, this.PartialMap.WithEnd(newEnd));
  }

  // Not ported: FromUnixAdjustmentRule and ConvertUnixRuleToBclAdjustmentRule (.NET Core on Unix's rules, read from
  // TZif files: noda-js only reads Windows' data; elsewhere it uses Intl).

  static FromWindowsAdjustmentRule(zone: TimeZoneInfo, rule: TimeZoneInfoAdjustmentRule): SystemDateTimeZoneBclAdjustmentRule {
    // With .NET 4.6, adjustment rules can have their own standard offsets, allowing
    // a much more reasonable set of time zone data. Unfortunately, this isn't directly
    // exposed, but we can detect it by just finding the UTC offset for an arbitrary
    // time within the rule - the start, in this case - and then take account of the
    // possibility of that being in daylight saving time. Fortunately, we only need
    // to do this during the setup.
    let ruleStandardOffset = zone.GetUtcOffset(rule.DateStart);
    if (zone.IsDaylightSavingTime(rule.DateStart)) {
      ruleStandardOffset -= rule.DaylightDelta;
    }
    const standardOffset = ToOffset(ruleStandardOffset);

    // Although the rule may have its own standard offset, the start/end is still determined
    // using the zone's standard offset.
    const zoneStandardOffset = ToOffset(zone.BaseUtcOffset);

    // Note: this extends back from DateTime.MinValue to start of time, even though the BCL can represent
    // as far back as 1AD. This is in the *spirit* of a rule which goes back that far.
    const start = rule.DateStart.Equals(DateTime.MinValue) ? Instant.BeforeMinValue : ToLocalDateTime(rule.DateStart).WithOffset(zoneStandardOffset).ToInstant();
    // The end instant (exclusive) is the end of the given date, so we need to add a day.
    const end = rule.DateEnd.Equals(MaxDate) ? Instant.AfterMaxValue : ToLocalDateTime(rule.DateEnd).PlusDays(1).WithOffset(zoneStandardOffset).ToInstant();
    const savings = ToOffset(rule.DaylightDelta);

    let partialMap: PartialZoneIntervalMap;
    // Some rules have DST start/end of "January 1st", to indicate that they're just in standard time. This is important
    // for rules which have a standard offset which is different to the standard offset of the zone itself.
    if (SystemDateTimeZoneBclAdjustmentRule.IsStandardOffsetOnlyRule(rule)) {
      partialMap = PartialZoneIntervalMap.ForZoneInterval(zone.StandardName, start, end, standardOffset, Offset.Zero);
    } else {
      const daylightRecurrence = new ZoneRecurrence(zone.DaylightName, savings, SystemDateTimeZoneBclAdjustmentRule.ConvertTransition(rule.DaylightTransitionStart), Int32.MinValue, Int32.MaxValue);
      const standardRecurrence = new ZoneRecurrence(zone.StandardName, Offset.Zero, SystemDateTimeZoneBclAdjustmentRule.ConvertTransition(rule.DaylightTransitionEnd), Int32.MinValue, Int32.MaxValue);
      let recurringMap: IZoneIntervalMap = StandardDaylightAlternatingMap.NewStandardOffsetStartRecurrenceEndRecurrence(standardOffset, standardRecurrence, daylightRecurrence);
      // Fake 1 hour savings if the adjustment rule claims to be 0 savings. See DaylightFakingZoneIntervalMap documentation below for more details.
      if (savings.Equals(Offset.Zero)) {
        recurringMap = new DaylightFakingZoneIntervalMap(recurringMap, zone.DaylightName);
      }
      partialMap = new PartialZoneIntervalMap(start, end, recurringMap);
    }
    return new SystemDateTimeZoneBclAdjustmentRule(standardOffset, savings, partialMap);
  }

  /**
   * The BCL represents "standard-only" rules using two fixed date January 1st transitions.
   * Currently the time-of-day used for the DST end transition is at one millisecond past midnight... we'll
   * be slightly more lenient, accepting anything up to 12:01...
   */
  private static IsStandardOffsetOnlyRule(rule: TimeZoneInfoAdjustmentRule): boolean {
    const daylight = rule.DaylightTransitionStart;
    const standard = rule.DaylightTransitionEnd;
    return daylight.IsFixedDateRule && daylight.Day === 1 && daylight.Month === 1 &&
      daylight.TimeOfDay.TimeOfDay < TimeSpanTicks.PerMinute &&
      standard.IsFixedDateRule && standard.Day === 1 && standard.Month === 1 &&
      standard.TimeOfDay.TimeOfDay < TimeSpanTicks.PerMinute;
  }

  // Converts a TimeZoneInfo "TransitionTime" to a "ZoneYearOffset" - the two correspond pretty closely.
  private static ConvertTransition(transitionTime: TimeZoneInfoTransitionTime): ZoneYearOffset {
    // Used for both fixed and non-fixed transitions.
    let timeOfDay = ToLocalDateTime(transitionTime.TimeOfDay).TimeOfDay;

    // Transitions at midnight are represented in the Windows database by a transition one millisecond early.
    // See BclDateTimeZoneTest.TransitionAtMidnight for a concrete example.
    // We adjust to midnight to represent the correct data - it's clear this is just a data fudge.
    // It's probably done like this to allow the rule to represent "Saturday 24:00" instead of "Sunday 00:00".
    let addDay = false;
    if (timeOfDay.Equals(OneMillisecondBeforeMidnight())) {
      timeOfDay = LocalTime.Midnight;
      addDay = true;
    }

    // Easy case - fixed day of the month.
    if (transitionTime.IsFixedDateRule) {
      return ZoneYearOffset.NewModeMonthOfYearDayOfMonthDayOfWeekAdvanceTimeOfDayAddDay(TransitionMode.Wall, transitionTime.Month, transitionTime.Day, 0, false, timeOfDay, addDay);
    }

    // Floating: 1st Sunday in March etc.
    const dayOfWeek = ToIsoDayOfWeek(transitionTime.DayOfWeek) as number;
    let dayOfMonth: number;
    let advance: boolean;
    // "Last"
    if (transitionTime.Week === 5) {
      advance = false;
      dayOfMonth = -1;
    } else {
      advance = true;
      // Week 1 corresponds to ">=1"
      // Week 2 corresponds to ">=8" etc
      dayOfMonth = (transitionTime.Week * 7) - 6;
    }
    return ZoneYearOffset.NewModeMonthOfYearDayOfMonthDayOfWeekAdvanceTimeOfDayAddDay(TransitionMode.Wall, transitionTime.Month, dayOfMonth, dayOfWeek, advance, timeOfDay, addDay);
  }
}

function TzNotFound(tz: string): DateTimeZoneNotFoundException {
  return new DateTimeZoneNotFoundException(`The TZ environment variable (${tz}) doesn't name a system time zone`);
}

let oneMillisecondBeforeMidnight: LocalTime | undefined;

function OneMillisecondBeforeMidnight(): LocalTime {
  return (oneMillisecondBeforeMidnight ??= new LocalTime(23, 59, 59, 999));
}

/**
 * An implementation of IZoneIntervalMap that delegates to an original map, except for where the result of a
 * ZoneInterval lookup has the given daylight name. In that case, a new ZoneInterval is built with the same
 * wall offset (and start/end instants etc), but with a savings of 1 hour. This is only used to work around TimeZoneInfo
 * adjustment rules with a daylight saving of 0 which are really trying to fake a more comprehensive solution.
 * (This is currently only seen on Mono on Linux...)
 * This addresses https://github.com/nodatime/nodatime/issues/746.
 * If TimeZoneInfo had sufficient flexibility to use different names for different periods of time, we'd have
 * another problem, as some "daylight names" don't always mean daylight - e.g. "BST" = British Summer Time and British Standard Time.
 * In this case, the limited nature of TimeZoneInfo works in our favour.
 */
class DaylightFakingZoneIntervalMap implements IZoneIntervalMap {
  get MinOffset(): Offset {
    return this._originalMap.MinOffset;
  }

  get MaxOffset(): Offset {
    return this._originalMap.MaxOffset;
  }

  constructor(private readonly _originalMap: IZoneIntervalMap, private readonly _daylightName: string) {}

  GetZoneInterval(instant: Instant): ZoneInterval {
    const interval = this._originalMap.GetZoneInterval(instant);
    return interval.Name === this._daylightName
      ? new ZoneInterval(this._daylightName, interval.RawStart, interval.RawEnd, interval.WallOffset, Offset.FromHours(1))
      : interval;
  }
}

/**
 * Representation of a time zone converted from a {@link TimeZoneInfo} (noda-js's port of the Base Class Library's): on
 * Windows, the system's own time zones, read as .NET reads them. (NodaTime's BclDateTimeZone.)
 *
 * noda-js: where the host can't read Windows' data (browsers, other operating systems, Windows without FFI or the
 * native addon), a zone comes from the host's Intl instead, and has no {@link SystemDateTimeZone.OriginalZone}. Intl
 * only reports the UTC offset at an instant, so the zone intervals are recovered by probing it (see
 * docs/Timezones.md for what that can't see).
 *
 * Two instances of this class are deemed equal if and only if they refer to the exact same
 * {@link TimeZoneInfo} object.
 *
 * This implementation does not always give the same results as `TimeZoneInfo`, in that it doesn't replicate
 * the bugs in the BCL interpretation of the data. These bugs are described in
 * [a blog post](https://codeblog.jonskeet.uk/2014/09/30/the-mysteries-of-bcl-time-zone-data/), but we're
 * not expecting them to be fixed any time soon. Being bug-for-bug compatible would not only be tricky, but would be painful
 * if the BCL were ever to be fixed. As far as we are aware, there are only discrepancies around new year where the zone
 * changes from observing one rule to observing another.
 *
 * As of version 3.0, a new "incompatible but doing the right thing" category of differences has been implemented,
 * for time zones which have a transition at 24:00. The Windows time zone data represents this as a transition at 23:59:59.999,
 * and that's faithfully represented by TimeZoneInfo (and BclDateTimeZone in version 2.x). As of 3.0, this is spotted
 * and converted to a midnight-on-the-following-day transition.
 *
 * This type is immutable reference type. See the thread safety section of the user guide for more information.
 */
export class SystemDateTimeZone extends DateTimeZone {
  /** @internal BclDateTimeZone.BclAdjustmentRule. */
  static readonly BclAdjustmentRule = SystemDateTimeZoneBclAdjustmentRule;

  private readonly _map: IZoneIntervalMap;
  private readonly _originalZone: TimeZoneInfo | null;
  private readonly _displayName: string | null;

  /**
   * Gets the original {@link TimeZoneInfo} from which this was created.
   *
   * noda-js: null for a zone from Intl.
   */
  get OriginalZone(): TimeZoneInfo | null {
    return this._originalZone;
  }

  /**
   * Gets the display name associated with the time zone, as provided by the Base Class Library.
   *
   * noda-js: for a zone from Intl, the host's English generic name for it (e.g. "Australian Eastern Time"), or its ID
   * where the host has none.
   */
  get DisplayName(): string {
    return this._originalZone !== null ? this._originalZone.DisplayName : (this._displayName ?? this.Id);
  }

  private constructor(id: string, isFixed: boolean, originalZone: TimeZoneInfo | null, displayName: string | null, map: IZoneIntervalMap) {
    super(id, isFixed, map.MinOffset, map.MaxOffset);
    this._originalZone = originalZone;
    this._displayName = displayName;
    this._map = map;
  }

  /** @inheritdoc */
  override GetZoneInterval(instant: Instant): ZoneInterval {
    return this._map.GetZoneInterval(instant);
  }

  /**
   * Creates a new {@link SystemDateTimeZone} from a {@link TimeZoneInfo}.
   * @param bclZone The original time zone to take information from.
   * @returns A {@link SystemDateTimeZone} wrapping the given `TimeZoneInfo`.
   */
  static FromTimeZoneInfo(bclZone: TimeZoneInfo): SystemDateTimeZone {
    Preconditions.CheckNotNull(bclZone, "bclZone");
    const standardOffset = ToOffset(bclZone.BaseUtcOffset);
    const rules = bclZone.GetAdjustmentRules();
    if (!bclZone.SupportsDaylightSavingTime || rules.length === 0) {
      const fixedInterval = new ZoneInterval(bclZone.StandardName, Instant.BeforeMinValue, Instant.AfterMaxValue, standardOffset, Offset.Zero);
      // (BclDateTimeZone's constructor passes SupportsDaylightSavingTime as DateTimeZone's isFixed.)
      return new SystemDateTimeZone(bclZone.Id, bclZone.SupportsDaylightSavingTime, bclZone, null, new SingleZoneIntervalMap(fixedInterval));
    }

    // noda-js: AreWindowsStyleRules is always true here (the rules are read from Windows' data), so the Unix rule
    // conversion (FromUnixAdjustmentRule, FixUnixTransitions) isn't ported.
    const convertedRules = rules.map(rule => SystemDateTimeZoneBclAdjustmentRule.FromWindowsAdjustmentRule(bclZone, rule));

    const uncachedMap = SystemDateTimeZone.BuildMap(convertedRules, standardOffset, bclZone.StandardName);
    const cachedMap = CachingZoneIntervalMap.CacheMap(uncachedMap);

    return new SystemDateTimeZone(bclZone.Id, bclZone.SupportsDaylightSavingTime, bclZone, null, cachedMap);
  }

  /**
   * noda-js: a zone from the host's Intl time zone with the given (IANA) ID, given the ID it's to have (a Windows ID,
   * where noda-js/system maps the host's zones to Windows IDs).
   * @throws {RangeError} The host doesn't support the IANA ID.
   * @internal
   */
  static FromIntl(id: string, ianaId: string): SystemDateTimeZone {
    const map = CachingZoneIntervalMap.CacheMap(CreateIntlZoneIntervalMap(ianaId));
    return new SystemDateTimeZone(id, false, null, GetIntlGenericName(ianaId), map);
  }

  // Not ported: AreWindowsStyleRules, FixUnixTransitions (for .NET Core on Unix's rules; see above).

  /** @internal */
  static BuildMap(rules: readonly SystemDateTimeZoneBclAdjustmentRule[], standardOffset: Offset, standardName: string): IZoneIntervalMap {
    Preconditions.CheckNotNull(standardName, "standardName");

    // First work out a naive list of partial maps. These will give the right offset at every instant, but not necessarily
    // correct intervals - we may we need to stitch intervals together.
    const maps: PartialZoneIntervalMap[] = [];
    // Handle the start of time until the start of the first rule, if necessary.
    if (rules[0]!.Start.IsValid) {
      maps.push(PartialZoneIntervalMap.ForZoneInterval(standardName, Instant.BeforeMinValue, rules[0]!.Start, standardOffset, Offset.Zero));
    }
    for (let i = 0; i < rules.length - 1; i++) {
      const beforeRule = rules[i]!;
      const afterRule = rules[i + 1]!;
      maps.push(beforeRule.PartialMap);
      // If there's a gap between this rule and the next one, fill it with a fixed interval.
      if (beforeRule.End.CompareTo(afterRule.Start) < 0) {
        maps.push(PartialZoneIntervalMap.ForZoneInterval(standardName, beforeRule.End, afterRule.Start, standardOffset, Offset.Zero));
      }
    }

    const lastRule = rules[rules.length - 1]!;
    maps.push(lastRule.PartialMap);

    // Handle the end of the last rule until the end of time, if necessary.
    if (lastRule.End.IsValid) {
      maps.push(PartialZoneIntervalMap.ForZoneInterval(standardName, lastRule.End, Instant.AfterMaxValue, standardOffset, Offset.Zero));
    }
    return PartialZoneIntervalMap.ConvertToFullMap(maps);
  }

  /**
   * Returns a time zone converted from the BCL representation of the system local time zone.
   *
   * This method is approximately equivalent to calling {@link IDateTimeZoneProvider.GetSystemDefault} with
   * an implementation that wraps {@link SystemDateTimeZoneSource} (e.g.
   * `SystemDateTimeZoneProvider`), with the exception that it will succeed even if the current local
   * time zone was not one of the set of system time zones captured when the source was created (which, while
   * highly unlikely, might occur either because the local time zone is not a system time zone, or because the
   * system time zones have themselves changed).
   *
   * This method will retain a reference to the returned `SystemDateTimeZone`, and will attempt to return it if
   * called repeatedly (assuming that the local time zone has not changed) rather than creating a new instance,
   * though this behaviour is not guaranteed.
   *
   * noda-js: if the TZ environment variable is set, the zone it names (as {@link SystemDateTimeZoneSource.GetSystemDefaultId}
   * resolves it). Otherwise, on Windows (with FFI or the native addon), TimeZoneInfo.Local, read from Windows as .NET
   * reads it (with "Adjust for daylight saving time automatically" turned off, it has no daylight saving time);
   * elsewhere, the host's Intl default zone.
   * @throws {InvalidOperationException} The system does not provide a time zone.
   * @throws {DateTimeZoneNotFoundException} The TZ environment variable is set, but there's no zone for it (not even UTC).
   * @returns A {@link SystemDateTimeZone} wrapping the "local" (system) time zone as returned by
   * TimeZoneInfo.Local.
   */
  static ForSystemDefault(): SystemDateTimeZone {
    const shim = TimeZoneInfoInterceptor.Shim;
    if (shim === null) {
      const tz = GetTZEnvironmentVariable();
      // noda-js: no TimeZoneInfo on this host: the Intl default zone (or TZ's).
      const intlDefault = IntlSystemTimeZones.ForHost().ForSystemDefault();
      if (intlDefault === null) {
        throw tz !== null ? TzNotFound(tz) : NewInvalidOperationException("No system default time zone is available");
      }
      return intlDefault;
    }
    // noda-js: TimeZoneInfo.Local is the zone the TZ environment variable names, if it's set
    // (System/LocalTimeZoneFromTZ.ts), as SystemDateTimeZoneSource.GetSystemDefaultId sees it.
    const local = TimeZoneInfoInterceptor.Local;
    if (local === null) {
      throw NewInvalidOperationException("No system default time zone is available");
    }
    let currentSystemDefault = systemDefault;

    // Cached copy is out of date - wrap a new one.
    // If currentSystemDefault is null, we always enter this block (as local isn't null).
    if (currentSystemDefault?.OriginalZone !== local) {
      currentSystemDefault = SystemDateTimeZone.FromTimeZoneInfo(local);
      systemDefault = currentSystemDefault;
    }
    // Always return our local variable; the field may have changed again.
    return currentSystemDefault;
  }

  /** @internal Clears the cache of {@link SystemDateTimeZone.ForSystemDefault} (for tests). */
  static ResetSystemDefaultCache(): void {
    systemDefault = null;
  }
}

