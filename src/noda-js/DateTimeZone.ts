// Ported from NodaTime 3.3.7: src/NodaTime/DateTimeZone.cs
// Copyright 2009 The Noda Time Authors. All rights reserved.
// Use of this source code is governed by the Apache License 2.0,
// as found in the LICENSE.txt file.

import {
  Duration,
  FixedDateTimeZone,
  Instant,
  Interval,
  Offset,
  OffsetDateTime,
  Preconditions,
  Resolvers,
  SkippedTimeException,
  ZonedDateTime,
  ZoneEqualityComparerOptions,
  ZoneEqualityComparerZoneIntervalEqualityComparer,
  ZoneLocalMapping,
} from "./internal.ts";
import type {
  IDateTimeZoneProvider, IZoneIntervalMap, LocalDate, LocalDateTime, LocalInstant, ZoneInterval, ZoneLocalMappingResolver,
} from "./internal.ts";
import { SecondsPerMinute } from "./NodaConstants.generated.ts";
import type { AmbiguousTimeException, DateTimeZoneCache, ZoneEqualityComparer } from "./internal.ts";
import { NewArgumentOutOfRangeException, NewInvalidOperationException, type ArgumentOutOfRangeException } from "./internal.ts";

const FixedZoneCacheGranularitySeconds = SecondsPerMinute * 30;
const FixedZoneCacheMinimumSeconds = -FixedZoneCacheGranularitySeconds * 12 * 2; // From UTC-12
const FixedZoneCacheSize = (12 + 15) * 2 + 1; // To UTC+15 inclusive

let utc: DateTimeZone | undefined;
let fixedZoneCache: DateTimeZone[] | undefined;

/**
 * Represents a time zone - a mapping between UTC and local time. A time zone maps UTC instants to local times
 *  - or, equivalently, to the offset from UTC at any particular instant.
 *
 * The mapping is unambiguous in the "UTC to local" direction, but
 * the reverse is not true: when the offset changes, usually due to a Daylight Saving transition,
 * the change either creates a gap (a period of local time which never occurs in the time zone)
 * or an ambiguity (a period of local time which occurs twice in the time zone). Mapping back from
 * local time to an instant requires consideration of how these problematic times will be handled.
 *
 * Noda Time provides various options when mapping local time to a specific instant:
 * - {@link AtStrictly} will throw an exception if the mapping from local time is either ambiguous
 *   or impossible, i.e. if there is anything other than one instant which maps to the given local time.
 * - {@link AtLeniently} will never throw an exception due to ambiguous or skipped times,
 *   resolving to the earlier option of ambiguous matches, or to a value that's forward-shifted by the duration
 *   of the gap for skipped times.
 * - {@link ResolveLocal} will apply a {@link ZoneLocalMappingResolver} to the result of
 *   a mapping.
 * - {@link MapLocal} will return a {@link ZoneLocalMapping}
 *   with complete information about whether the given local time occurs zero times, once or twice. This is the most
 *   fine-grained approach, which is the fiddliest to use but puts the caller in the most control.
 *
 * Noda Time has two built-in sources of time zone data available: a copy of the
 * <a href="https://www.iana.org/time-zones">tz database</a> (also known as the IANA Time Zone database, or zoneinfo
 * or Olson database), and the ability to convert .NET's own `TimeZoneInfo` format into a "native" Noda
 * Time zone. Which of these is most appropriate for you to use will very much depend on your exact needs. The
 * zoneinfo database is widely used outside Windows, and has more historical data than the Windows-provided
 * information, but if you need to interoperate with other Windows systems by specifying time zone IDs, you may
 * wish to stick to the Windows time zones.
 * (noda-js: the tz database is available from the `noda-js/tzdb` entry points, and the host system's own
 * time zones from `noda-js/system`.)
 *
 * To obtain a {@link DateTimeZone} for a given timezone ID, use one of the methods on
 * {@link IDateTimeZoneProvider}. The UTC timezone is also available via the {@link DateTimeZone.Utc} property on this class.
 *
 * To obtain a {@link DateTimeZone} representing the system default time zone, you can
 * call {@link IDateTimeZoneProvider.GetSystemDefault} on a provider to obtain the {@link DateTimeZone} that
 * the provider considers matches the system default time zone.
 *
 * Note that Noda Time does not require that {@link DateTimeZone} instances be singletons.
 * Comparing two time zones for equality is not straightforward: if you care about whether two
 * zones act the same way within a particular portion of time, use {@link ZoneEqualityComparer}.
 * Additional guarantees are provided by {@link IDateTimeZoneProvider} and {@link DateTimeZone.ForOffset}.
 *
 * All time zone implementations within Noda Time are immutable and thread-safe.
 * It is expected that third party implementations will be immutable as well:
 * code within Noda Time assumes that it can hand out time zones freely.
 */
export abstract class DateTimeZone implements IZoneIntervalMap {
  /**
   * The ID of the UTC (Coordinated Universal Time) time zone. This ID is always valid, whatever provider is
   * used. If the provider has its own mapping for UTC, that will be returned by {@link DateTimeZoneCache.GetZoneOrNull}, but otherwise
   * the value of the {@link DateTimeZone.Utc} property will be returned.
   * @internal
   */
  static readonly UtcId = "UTC";

  /**
   * Gets the UTC (Coordinated Universal Time) time zone.
   *
   * This is a single instance which is not provider-specific; it is guaranteed to have the ID "UTC", and to
   * compare equal to an instance returned by calling {@link DateTimeZone.ForOffset} with an offset of zero, but it may
   * or may not compare equal to an instance returned by e.g. a tzdb provider's `get("UTC")`.
   */
  static get Utc(): DateTimeZone {
    return (utc ??= new FixedDateTimeZone(Offset.Zero));
  }

  private static get FixedZoneCache(): DateTimeZone[] {
    return (fixedZoneCache ??= DateTimeZone.BuildFixedZoneCache());
  }

  /**
   * Returns a fixed time zone with the given offset.
   *
   * The returned time zone will have an ID of "UTC" if the offset is zero, or "UTC+/-Offset"
   * otherwise. In the former case, the returned instance will be equal to {@link DateTimeZone.Utc}.
   *
   * Note also that this method is not required to return the same {@link DateTimeZone} instance for
   * successive requests for the same offset; however, all instances returned for a given offset will compare
   * as equal.
   *
   * @param offset The offset for the returned time zone
   * @returns A fixed time zone with the given offset.
   */
  static ForOffset(offset: Offset): DateTimeZone {
    const seconds = offset.Seconds;
    if (seconds % FixedZoneCacheGranularitySeconds !== 0) {
      return new FixedDateTimeZone(offset);
    }
    const index = Math.trunc((seconds - FixedZoneCacheMinimumSeconds) / FixedZoneCacheGranularitySeconds);
    if (index < 0 || index >= FixedZoneCacheSize) {
      return new FixedDateTimeZone(offset);
    }
    return DateTimeZone.FixedZoneCache[index]!;
  }

  /**
   * Initializes a new instance of the {@link DateTimeZone} class.
   *
   * @param id The unique id of this time zone.
   * @param isFixed Set to `true` if this time zone has no transitions.
   * @param minOffset Minimum offset applied within this zone
   * @param maxOffset Maximum offset applied within this zone
   */
  protected constructor(id: string, isFixed: boolean, minOffset: Offset, maxOffset: Offset) {
    this._id = Preconditions.CheckNotNull(id, "id");
    this.IsFixed = isFixed;
    this._minOffset = minOffset;
    this._maxOffset = maxOffset;
  }

  private readonly _id: string;

  /**
   * Get the provider's ID for the time zone.
   *
   * This identifies the time zone within the current time zone provider; a different provider may
   * provide a different time zone with the same ID, or may not provide a time zone with that ID at all.
   */
  get Id(): string {
    return this._id;
  }

  /**
   * Indicates whether the time zone is fixed, i.e. contains no transitions.
   *
   * This is used as an optimization. If the time zone has no transitions but returns `false`
   * for this then the behavior will be correct but the system will have to do extra work. However
   * if the time zone has transitions and this returns `true` then the transitions will never
   * be examined.
   * @internal
   */
  readonly IsFixed: boolean;

  private readonly _minOffset: Offset;

  /**
   * Gets the least (most negative) offset within this time zone, over all time.
   */
  get MinOffset(): Offset {
    return this._minOffset;
  }

  private readonly _maxOffset: Offset;

  /**
   * Gets the greatest (most positive) offset within this time zone, over all time.
   */
  get MaxOffset(): Offset {
    return this._maxOffset;
  }

  // #region Core abstract/virtual methods
  /**
   * Returns the offset from UTC, where a positive duration indicates that local time is
   * later than UTC. In other words, local time = UTC + offset.
   *
   * This is mostly a convenience method for calling `GetZoneInterval(instant).WallOffset`,
   * although it can also be overridden for more efficiency.
   *
   * @param instant The instant for which to calculate the offset.
   * @returns The offset from UTC at the specified instant.
   */
  GetUtcOffset(instant: Instant): Offset {
    return this.GetZoneInterval(instant).WallOffset;
  }

  // Note for CA2119:
  // IZoneIntervalMap is primarily used while *building* time zones, but is also implemented by DateTimeZone for simplicity
  // of caching. (BclDateTimeZone always returns a cached date time zone having created an IZoneIntervalMap.)
  // While a regular user can create their own DateTimeZone implementation, that would never end up being cached
  // because CachedDateTimeZone.ForZone is internal anyway.
  // In other words: we don't believe this can be exploited.

  /**
   * Gets the zone interval for the given instant; the range of time around the instant in which the same Offset
   * applies (with the same split between standard time and daylight saving time, and with the same offset).
   *
   * This will always return a valid zone interval, as time zones cover the whole of time.
   *
   * @param instant The {@link Instant} to query.
   * @returns The defined {@link ZoneInterval}.
   * @see GetZoneIntervals
   */
  abstract GetZoneInterval(instant: Instant): ZoneInterval;

  /**
   * Returns complete information about how the given {@link LocalDateTime} is mapped in this time zone.
   *
   * Mapping a local date/time to a time zone can give an unambiguous, ambiguous or impossible result, depending on
   * time zone transitions. Use the return value of this method to handle these cases in an appropriate way for
   * your use case.
   *
   * As an alternative, consider {@link ResolveLocal}, which uses a caller-provided strategy to
   * convert the {@link ZoneLocalMapping} returned here to a {@link ZonedDateTime}.
   *
   * @param localDateTime The local date and time to map in this time zone.
   * @returns A mapping of the given local date and time to zero, one or two zoned date/time values.
   */
  MapLocal(localDateTime: LocalDateTime): ZoneLocalMapping {
    const localInstant: LocalInstant = localDateTime.ToLocalInstant();
    const firstGuess: Instant = localInstant.MinusZeroOffset();
    const interval: ZoneInterval = this.GetZoneInterval(firstGuess);

    // Most of the time we'll go into here... the local instant and the instant
    // are close enough that we've found the right instant.
    if (interval.Contains(localInstant)) {
      const earlier = this.GetEarlierMatchingInterval(interval, localInstant);
      if (earlier !== null) {
        return ZoneLocalMapping.NewZoneLocalDateTimeEarlyIntervalLateIntervalCount(this, localDateTime, earlier, interval, 2);
      }
      const later = this.GetLaterMatchingInterval(interval, localInstant);
      if (later !== null) {
        return ZoneLocalMapping.NewZoneLocalDateTimeEarlyIntervalLateIntervalCount(this, localDateTime, interval, later, 2);
      }
      return ZoneLocalMapping.NewZoneLocalDateTimeEarlyIntervalLateIntervalCount(this, localDateTime, interval, interval, 1);
    } else {
      // Our first guess was wrong. Either we need to change interval by one (either direction)
      // or we're in a gap.
      const earlier = this.GetEarlierMatchingInterval(interval, localInstant);
      if (earlier !== null) {
        return ZoneLocalMapping.NewZoneLocalDateTimeEarlyIntervalLateIntervalCount(this, localDateTime, earlier, earlier, 1);
      }
      const later = this.GetLaterMatchingInterval(interval, localInstant);
      if (later !== null) {
        return ZoneLocalMapping.NewZoneLocalDateTimeEarlyIntervalLateIntervalCount(this, localDateTime, later, later, 1);
      }
      return ZoneLocalMapping.NewZoneLocalDateTimeEarlyIntervalLateIntervalCount(this, localDateTime,
        this.GetIntervalBeforeGap(localInstant), this.GetIntervalAfterGap(localInstant), 0);
    }
  }
  // #endregion

  // #region Conversion between local dates/times and ZonedDateTime
  /**
   * Returns the earliest valid {@link ZonedDateTime} with the given local date.
   *
   * If midnight exists unambiguously on the given date, it is returned.
   * If the given date has an ambiguous start time (e.g. the clocks go back from 1am to midnight)
   * then the earlier ZonedDateTime is returned. If the given date has no midnight (e.g. the clocks
   * go forward from midnight to 1am) then the earliest valid value is returned; this will be the instant
   * of the transition.
   *
   * @param date The local date to map in this time zone.
   * @throws {SkippedTimeException} The entire day was skipped due to a very large time zone transition.
   * (This is extremely rare.)
   * @returns The {@link ZonedDateTime} representing the earliest time in the given date, in this time zone.
   */
  AtStartOfDay(date: LocalDate): ZonedDateTime {
    const midnight: LocalDateTime = date.AtMidnight();
    const mapping = this.MapLocal(midnight);
    switch (mapping.Count) {
      // Midnight doesn't exist. Maybe we just skip to 1am (or whatever), or maybe the whole day is missed.
      case 0: {
        const interval = mapping.LateInterval;
        // Safe to use Start, as it can't extend to the start of time.
        const offsetDateTime = OffsetDateTime.NewInstantOffsetCalendar(interval.Start, interval.WallOffset, date.Calendar);
        // It's possible that the entire day is skipped. For example, Samoa skipped December 30th 2011.
        // We know the two values are in the same calendar here, so we just need to check the YearMonthDay.
        if (!offsetDateTime.YearMonthDay.Equals(date.YearMonthDay)) {
          throw new SkippedTimeException(midnight, this);
        }
        return ZonedDateTime.NewOffsetDateTimeZone(offsetDateTime, this);
      }
      // Unambiguous or occurs twice, we can just use the offset from the earlier interval.
      case 1:
      case 2:
        return ZonedDateTime.NewOffsetDateTimeZone(midnight.WithOffset(mapping.EarlyInterval.WallOffset), this);
      default:
        throw NewInvalidOperationException("This won't happen.");
    }
  }

  /**
   * Maps the given {@link LocalDateTime} to the corresponding {@link ZonedDateTime}, following
   * the given {@link ZoneLocalMappingResolver} to handle ambiguity and skipped times.
   *
   * This is a convenience method for calling {@link MapLocal} and passing the result to the resolver.
   * Common options for resolvers are provided in the static {@link Resolvers} class.
   *
   * See {@link AtStrictly} and {@link AtLeniently} for alternative ways to map a local time to a
   * specific instant.
   *
   * @param localDateTime The local date and time to map in this time zone.
   * @param resolver The resolver to apply to the mapping.
   * @returns The result of resolving the mapping.
   */
  ResolveLocal(localDateTime: LocalDateTime, resolver: ZoneLocalMappingResolver): ZonedDateTime {
    Preconditions.CheckNotNull(resolver, "resolver");
    return resolver(this.MapLocal(localDateTime));
  }

  /**
   * Maps the given {@link LocalDateTime} to the corresponding {@link ZonedDateTime}, if and only if
   * that mapping is unambiguous in this time zone.  Otherwise, {@link SkippedTimeException} or
   * {@link AmbiguousTimeException} is thrown, depending on whether the mapping is ambiguous or the local
   * date/time is skipped entirely.
   *
   * See {@link AtLeniently} and {@link ResolveLocal} for alternative ways to map a local time to a
   * specific instant.
   *
   * @param localDateTime The local date and time to map into this time zone.
   * @throws {SkippedTimeException} The given local date/time is skipped in this time zone.
   * @throws {AmbiguousTimeException} The given local date/time is ambiguous in this time zone.
   * @returns The unambiguous matching {@link ZonedDateTime} if it exists.
   */
  AtStrictly(localDateTime: LocalDateTime): ZonedDateTime {
    return this.ResolveLocal(localDateTime, Resolvers.StrictResolver);
  }

  /**
   * Maps the given {@link LocalDateTime} to the corresponding {@link ZonedDateTime} in a lenient
   * manner: ambiguous values map to the earlier of the alternatives, and "skipped" values are shifted forward
   * by the duration of the "gap".
   *
   * See {@link AtStrictly} and {@link ResolveLocal} for alternative ways to map a local time to a
   * specific instant.
   *
   * Note: The behavior of this method was changed in version 2.0 to fit the most commonly seen real-world
   * usage pattern.  Previous versions returned the later instance of ambiguous values, and returned the start of
   * the zone interval after the gap for skipped value.  The previous functionality can still be used if desired,
   * by using {@link ResolveLocal}, passing in a resolver
   * created from {@link Resolvers.ReturnLater} and {@link Resolvers.ReturnStartOfIntervalAfter}.
   *
   * @param localDateTime The local date/time to map.
   * @returns The unambiguous mapping if there is one, the earlier result if the mapping is ambiguous,
   * or the forward-shifted value if the given local date/time is skipped.
   */
  AtLeniently(localDateTime: LocalDateTime): ZonedDateTime {
    return this.ResolveLocal(localDateTime, Resolvers.LenientResolver);
  }
  // #endregion

  /**
   * Returns the interval before this one, if it contains the given local instant, or null otherwise.
   */
  private GetEarlierMatchingInterval(interval: ZoneInterval, localInstant: LocalInstant): ZoneInterval | null {
    // Micro-optimization to avoid fetching interval.Start multiple times. Seems
    // to give a performance improvement on x86 at least...
    // If the zone interval extends to the start of time, the next check will definitely evaluate to false.
    const intervalStart: Instant = interval.RawStart;
    // This allows for a maxOffset of up to +1 day, and the "truncate towards beginning of time"
    // nature of the Days property.
    if (localInstant.DaysSinceEpoch <= intervalStart.DaysSinceEpoch + 1) {
      // We *could* do a more accurate check here based on the actual maxOffset, but it's probably
      // not worth it.
      const candidate = this.GetZoneInterval(intervalStart.Minus(Duration.Epsilon));
      if (candidate.Contains(localInstant)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Returns the next interval after this one, if it contains the given local instant, or null otherwise.
   */
  private GetLaterMatchingInterval(interval: ZoneInterval, localInstant: LocalInstant): ZoneInterval | null {
    // Micro-optimization to avoid fetching interval.End multiple times. Seems
    // to give a performance improvement on x86 at least...
    // If the zone interval extends to the end of time, the next check will
    // definitely evaluate to false.
    const intervalEnd: Instant = interval.RawEnd;
    // Crude but cheap first check to see whether there *might* be a later interval.
    // This allows for a minOffset of up to -1 day, and the "truncate towards beginning of time"
    // nature of the Days property.
    if (localInstant.DaysSinceEpoch >= intervalEnd.DaysSinceEpoch - 1) {
      // We *could* do a more accurate check here based on the actual maxOffset, but it's probably
      // not worth it.
      const candidate = this.GetZoneInterval(intervalEnd);
      if (candidate.Contains(localInstant)) {
        return candidate;
      }
    }
    return null;
  }

  private GetIntervalBeforeGap(localInstant: LocalInstant): ZoneInterval {
    const guess: Instant = localInstant.MinusZeroOffset();
    const guessInterval = this.GetZoneInterval(guess);
    // If the local interval occurs before the zone interval we're looking at starts,
    // we need to find the earlier one; otherwise this interval must come after the gap, and
    // it's therefore the one we want.
    if (localInstant.Minus(guessInterval.WallOffset).CompareTo(guessInterval.RawStart) < 0) {
      return this.GetZoneInterval(guessInterval.Start.Minus(Duration.Epsilon));
    } else {
      return guessInterval;
    }
  }

  private GetIntervalAfterGap(localInstant: LocalInstant): ZoneInterval {
    const guess: Instant = localInstant.MinusZeroOffset();
    const guessInterval = this.GetZoneInterval(guess);
    // If the local interval occurs before the zone interval we're looking at starts,
    // it's the one we're looking for. Otherwise, we need to find the next interval.
    if (localInstant.Minus(guessInterval.WallOffset).CompareTo(guessInterval.RawStart) < 0) {
      return guessInterval;
    } else {
      // Will definitely be valid - there can't be a gap after an infinite interval.
      return this.GetZoneInterval(guessInterval.End);
    }
  }

  // #region Object overrides
  /**
   * Returns the ID of this time zone.
   *
   * @returns The ID of this time zone.
   */
  toString(): string {
    return this.Id;
  }

  /**
   * Determines whether the specified object is equal to this time zone.
   *
   * noda-js: the equivalent of .NET's object.Equals, which DateTimeZone doesn't override: reference equality.
   * Subclasses (e.g. fixed-offset zones) override it, as in NodaTime.
   */
  Equals(obj: unknown): boolean {
    return this === obj;
  }
  // #endregion

  /**
   * Creates a fixed time zone for offsets -12 to +15 at every half hour,
   * fixing the 0 offset as DateTimeZone.Utc.
   */
  private static BuildFixedZoneCache(): DateTimeZone[] {
    const ret = new Array<DateTimeZone>(FixedZoneCacheSize);
    for (let i = 0; i < FixedZoneCacheSize; i++) {
      const offsetSeconds = i * FixedZoneCacheGranularitySeconds + FixedZoneCacheMinimumSeconds;
      ret[i] = new FixedDateTimeZone(Offset.FromSeconds(offsetSeconds));
    }
    ret[-FixedZoneCacheMinimumSeconds / FixedZoneCacheGranularitySeconds] = DateTimeZone.Utc;
    return ret;
  }

  /**
   * Returns all the zone intervals which occur for any instant in the interval [`start`, `end`).
   *
   * This method is simply a convenience method for calling {@link GetZoneIntervals} with an {@link Interval} without
   * explicitly constructing the interval beforehand.
   *
   * @param start Inclusive start point of the interval for which to retrieve zone intervals.
   * @param end Exclusive end point of the interval for which to retrieve zone intervals.
   * @throws {ArgumentOutOfRangeException} `end` is earlier than `start`.
   * @returns A sequence of zone intervals covering the given interval.
   * @see DateTimeZone.GetZoneInterval
   */
  GetZoneIntervals(start: Instant, end: Instant): Iterable<ZoneInterval>;
  /**
   * Returns all the zone intervals which occur for any instant in the given interval.
   *
   * The zone intervals are returned in chronological order.
   * This method is equivalent to calling {@link DateTimeZone.GetZoneInterval} for every
   * instant in the interval and then collapsing to a set of distinct zone intervals.
   * The first and last zone intervals are likely to also cover instants outside the given interval;
   * the zone intervals returned are not truncated to match the start and end points.
   *
   * @param interval Interval to find zone intervals for. This is allowed to be unbounded (i.e.
   * infinite in both directions).
   * @returns A sequence of zone intervals covering the given interval.
   * @see DateTimeZone.GetZoneInterval
   */
  GetZoneIntervals(interval: Interval): Iterable<ZoneInterval>;
  /**
   * Returns the zone intervals within the given interval, potentially coalescing some of the
   * original intervals according to options.
   *
   * This is equivalent to {@link GetZoneIntervals} without options, but may coalesce some intervals.
   * For example, if the {@link ZoneEqualityComparerOptions.OnlyMatchWallOffset} is specified,
   * and two consecutive zone intervals have the same offset but different names, a single zone interval
   * will be returned instead of two separate ones. When zone intervals are coalesced, all aspects of
   * the first zone interval are used except its end instant, which is taken from the second zone interval.
   *
   * As the options are only used to determine which intervals to coalesce, the
   * {@link ZoneEqualityComparerOptions.MatchStartAndEndTransitions} option does not affect
   * the intervals returned.
   *
   * @param interval Interval to find zone intervals for. This is allowed to be unbounded (i.e.
   * infinite in both directions).
   * @param options
   */
  GetZoneIntervals(interval: Interval, options: ZoneEqualityComparerOptions): Iterable<ZoneInterval>;
  GetZoneIntervals(startOrInterval: Instant | Interval, endOrOptions?: Instant | ZoneEqualityComparerOptions): Iterable<ZoneInterval> {
    if (startOrInterval instanceof Instant) {
      // The constructor performs all the validation we need.
      return this.GetZoneIntervalsImpl(new Interval(startOrInterval, endOrOptions as Instant));
    }
    const interval = startOrInterval;
    if (endOrOptions === undefined) {
      return this.GetZoneIntervalsImpl(interval);
    }
    const options = endOrOptions as ZoneEqualityComparerOptions;
    if ((options & ~ZoneEqualityComparerOptions.StrictestMatch) !== 0) {
      throw NewArgumentOutOfRangeException("options", undefined,
        `The value ${options} is not defined within ZoneEqualityComparer.Options`);
    }
    const zoneIntervalEqualityComparer = new ZoneEqualityComparerZoneIntervalEqualityComparer(options, interval);
    const originalIntervals = this.GetZoneIntervalsImpl(interval);
    return zoneIntervalEqualityComparer.CoalesceIntervals(originalIntervals);
  }

  // noda-js: the iterator body of GetZoneIntervals(Interval), separated so that the overload dispatch
  // above (and its argument validation) runs eagerly, as in NodaTime.
  private *GetZoneIntervalsImpl(interval: Interval): Generator<ZoneInterval> {
    let current = interval.HasStart ? interval.Start : Instant.MinValue;
    const end = interval.RawEnd;
    while (current.CompareTo(end) < 0) {
      const zoneInterval = this.GetZoneInterval(current);
      yield zoneInterval;
      // If this is the end of time, this will just fail on the next comparison.
      current = zoneInterval.RawEnd;
    }
  }

  // #region JSON
  /**
   * Returns the ID of this time zone, as NodaTime.Serialization.SystemTextJson writes it.
   */
  toJSON(): string {
    return this.Id;
  }

  /**
   * Returns the time zone with the given ID (as written by {@link toJSON}) from the given provider.
   *
   * @throws {DateTimeZoneNotFoundException} The provider does not support the given ID.
   */
  static fromJSON(json: string, provider: IDateTimeZoneProvider): DateTimeZone {
    Preconditions.CheckNotNull(provider, "provider");
    return provider.Get(json);
  }
  // #endregion
}
