// noda-js: new code. Time zones from the host's Intl implementation, for noda-js/system where it can't read the
// operating system's own data (browsers, non-Windows hosts, Windows without FFI): the zone intervals are recovered by
// probing Intl.DateTimeFormat for UTC offsets. Also Intl helpers for IDs (the host's zone, its supported zones,
// canonical IDs) and the host's tz version.

import { Instant, Offset, ZoneInterval } from "../internal.ts";
import type { IZoneIntervalMap } from "../internal.ts";

// Node's process object, where present (declared here as the build has no Node types).
declare const process: { versions?: { tz?: unknown } } | undefined;

// How the zone rules are recovered from Intl
// ------------------------------------------
// Intl only answers "what is the UTC offset (and abbreviation) at this instant?". Transitions are found by
// probing: each UTC calendar year is sampled every ProbeStepDays days, and wherever two neighbouring samples
// differ, a binary search narrows the change down to the millisecond. The transitions of each year are computed
// once and cached; zone intervals are then cached again by CachingZoneIntervalMap.
//
// Limitations (all documented on SystemDateTimeZone and in docs/Timezones.md):
// - A pair of transitions closer together than ProbeStepDays that returns to the same offset is not seen.
// - A change of abbreviation without a change of offset is not a transition.
// - Before MinProbeYear, the offset is taken to be the offset at the start of MinProbeYear. (tzdb has no
//   transitions before 1844, and engines report local mean time for earlier dates.)
// - From FinalRuleYear onwards, the zone is assumed to follow a single final rule (as ICU does after the
//   last explicit transition): if FinalRuleYear has no transitions, no later year does either.
// - Intl gives only the total offset. The standard offset of an interval is the smallest offset in force in the
//   UTC year the interval starts in (the same heuristic as BclDateTimeZone's fallback), so savings are approximate.

const MillisecondsPerDay = 86_400_000;
/** The first UTC year that is probed. */
const MinProbeYear = 1800;
/** From this year on, the zone is assumed to follow its final rule. */
const FinalRuleYear = 2040;
/** The last year that can be probed (the last year of NodaTime's Instant range). */
const MaxProbeYear = 9999;
/** The interval between offset samples. */
const ProbeStepMilliseconds = 7 * MillisecondsPerDay;
/** The years sampled (at the start of each quarter) to estimate the minimum and maximum offsets. */
const OffsetRangeSampleMonths = [0, 3, 6, 9];
/** The largest daylight saving the standard-offset heuristic will infer (the largest in tzdb is 2 hours). */
const MaxSavingsSeconds = 2 * 3600;

/** Milliseconds since the Unix epoch at the start of the given UTC year. (Date.UTC treats years 0-99 as 1900-1999.) */
function UtcYearStart(year: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, 0, 1);
  return date.getTime();
}

function UtcMonthStart(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 1);
  return date.getTime();
}

function UtcYear(ms: number): number {
  return new Date(ms).getUTCFullYear();
}

/** A transition found by probing: the first millisecond of a new offset. */
interface ProbedTransition {
  readonly Milliseconds: number;
  readonly OffsetSeconds: number;
}

/** The transitions within one UTC year, [start of year, start of next year). */
interface YearData {
  /** The offset in force just before the start of the year. */
  readonly StartOffsetSeconds: number;
  readonly Transitions: readonly ProbedTransition[];
}

/**
 * Reads offsets and abbreviations for one time zone from Intl.
 */
class IntlZoneProbe {
  /** Formatter whose output ends with a "GMT+hh:mm[:ss]" offset, or null if the host doesn't support "longOffset". */
  private readonly _offsetFormat: Intl.DateTimeFormat | null;
  /** Fallback: formatter for the wall-clock fields, used to work out the offset if "longOffset" isn't available. */
  private _wallFormat: Intl.DateTimeFormat | undefined;
  private _nameFormat: Intl.DateTimeFormat | undefined;

  /**
   * @throws {RangeError} The host doesn't support the given time zone ID.
   */
  constructor(readonly Id: string) {
    // This throws a RangeError for an unknown time zone.
    new Intl.DateTimeFormat("en-US", { timeZone: Id });
    let offsetFormat: Intl.DateTimeFormat | null = null;
    try {
      const format = new Intl.DateTimeFormat("en-US", { timeZone: Id, timeZoneName: "longOffset", hour: "numeric" });
      if (format.resolvedOptions().timeZoneName === "longOffset" && IntlZoneProbe.ParseLongOffset(format.format(0)) !== null) {
        offsetFormat = format;
      }
    } catch {
      // Older engines throw a RangeError for timeZoneName: "longOffset".
    }
    this._offsetFormat = offsetFormat;
  }

  /** The UTC offset in force at the given time, in seconds. */
  OffsetSecondsAt(ms: number): number {
    if (this._offsetFormat !== null) {
      const seconds = IntlZoneProbe.ParseLongOffset(this._offsetFormat.format(ms));
      if (seconds !== null) {
        return seconds;
      }
    }
    return this.OffsetSecondsFromWallFields(ms);
  }

  /** The host's English abbreviation for the zone at the given time (e.g. "AEST", or "GMT+5:30"). */
  NameAt(ms: number): string {
    this._nameFormat ??= new Intl.DateTimeFormat("en-US", { timeZone: this.Id, timeZoneName: "short", hour: "numeric" });
    // eslint-disable-next-line es-x/no-intl-datetimeformat-prototype-formattoparts -- noda-js/system's Intl fallback needs formatToParts (ES2017 Intl; see README)
    const part = this._nameFormat.formatToParts(ms).find((p) => p.type === "timeZoneName");
    return part?.value ?? this.Id;
  }

  /** Parses the offset at the end of text such as "2 AM GMT+05:30", "2 AM GMT-03:00:00" or "2 AM GMT". */
  private static ParseLongOffset(text: string): number | null {
    const index = text.lastIndexOf("GMT");
    if (index < 0) {
      return null;
    }
    const rest = text.substring(index + 3).trim();
    if (rest === "") {
      return 0;
    }
    // The sign is "+", "-" (U+002D) or "−" (U+2212 MINUS SIGN). CLDR writes negative offsets with U+2212 in some
    // locales (sv-SE gives "GMT−05:00"); the formatter asks for en-US, which gives "-" on current engines, but a
    // host's locale data may differ, so both are accepted.
    const match = /^([+\-−])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(rest);
    if (match === null) {
      return null;
    }
    const sign = match[1] === "+" ? 1 : -1;
    return sign * (Number(match[2]) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0));
  }

  private OffsetSecondsFromWallFields(ms: number): number {
    this._wallFormat ??= new Intl.DateTimeFormat("en-US", {
      timeZone: this.Id,
      // noda-js: hour12 rather than hourCycle ("h23"), which engines before ES2020 ignore (giving a 12-hour clock
      // for en-US). Some engines give hour 24 at midnight with this; see below.
      hour12: false,
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    let year = 0;
    let month = 1;
    let day = 1;
    let hour = 0;
    let minute = 0;
    let second = 0;
    let beforeCommonEra = false;
    // eslint-disable-next-line es-x/no-intl-datetimeformat-prototype-formattoparts -- noda-js/system's Intl fallback needs formatToParts (ES2017 Intl; see README)
    for (const part of this._wallFormat.formatToParts(ms)) {
      switch (part.type) {
        case "era":
          beforeCommonEra = part.value.startsWith("B");
          break;
        case "year":
          year = Number(part.value);
          break;
        case "month":
          month = Number(part.value);
          break;
        case "day":
          day = Number(part.value);
          break;
        case "hour":
          // Some engines report midnight as 24 even with hourCycle h23.
          hour = Number(part.value) % 24;
          break;
        case "minute":
          minute = Number(part.value);
          break;
        case "second":
          second = Number(part.value);
          break;
      }
    }
    if (beforeCommonEra) {
      year = 1 - year;
    }
    const local = new Date(0);
    local.setUTCFullYear(year, month - 1, day);
    local.setUTCHours(hour, minute, second, 0);
    // The formatted wall time is truncated to the second.
    const wholeSecondMs = Math.floor(ms / 1000) * 1000;
    return Math.round((local.getTime() - wholeSecondMs) / 1000);
  }
}

/**
 * The zone interval map of a time zone from Intl: zone intervals recovered by probing.
 */
class IntlZoneIntervalMap implements IZoneIntervalMap {
  private readonly _years = new Map<number, YearData>();
  readonly MinOffset: Offset;
  readonly MaxOffset: Offset;

  constructor(private readonly _probe: IntlZoneProbe) {
    // Estimate the offset range from samples at the start of each quarter. (Computing it exactly would mean
    // finding every transition in history.)
    let min = _probe.OffsetSecondsAt(UtcYearStart(MinProbeYear) - 1);
    let max = min;
    for (let year = MinProbeYear; year <= FinalRuleYear; year++) {
      for (const month of OffsetRangeSampleMonths) {
        const offset = _probe.OffsetSecondsAt(UtcMonthStart(year, month));
        min = Math.min(min, offset);
        max = Math.max(max, offset);
      }
    }
    this.MinOffset = Offset.FromSeconds(min);
    this.MaxOffset = Offset.FromSeconds(max);
  }

  GetZoneInterval(instant: Instant): ZoneInterval {
    const ms = instant.ToUnixTimeMilliseconds();
    const year = Math.min(Math.max(UtcYear(ms), MinProbeYear), MaxProbeYear);
    const data = this.GetYearData(year);
    const transitions = data.Transitions;
    // The last transition at or before the instant (if any in this year).
    let index = -1;
    while (index + 1 < transitions.length && transitions[index + 1]!.Milliseconds <= ms) {
      index++;
    }
    const wallOffsetSeconds = index >= 0 ? transitions[index]!.OffsetSeconds : data.StartOffsetSeconds;
    const startMs = index >= 0 ? transitions[index]!.Milliseconds : this.FindPreviousTransition(year - 1);
    const endMs = index + 1 < transitions.length ? transitions[index + 1]!.Milliseconds : this.FindNextTransition(year + 1);

    // Standard offset heuristic: the smallest offset in force during the UTC year in which the interval starts,
    // ignoring offsets more than MaxSavingsSeconds below this one (such as a jump across the date line).
    const startYearData = this.GetYearData(startMs === null ? MinProbeYear : Math.min(Math.max(UtcYear(startMs), MinProbeYear), MaxProbeYear));
    let standardOffsetSeconds = wallOffsetSeconds;
    for (const offsetSeconds of [startYearData.StartOffsetSeconds, ...startYearData.Transitions.map((t) => t.OffsetSeconds)]) {
      if (offsetSeconds < standardOffsetSeconds && wallOffsetSeconds - offsetSeconds <= MaxSavingsSeconds) {
        standardOffsetSeconds = offsetSeconds;
      }
    }

    const name = this._probe.NameAt(startMs ?? UtcYearStart(MinProbeYear) - 1);
    return ZoneInterval.NewNameStartEndWallOffsetSavings(
      name,
      startMs === null ? Instant.BeforeMinValue : Instant.FromUnixTimeMilliseconds(startMs),
      endMs === null ? Instant.AfterMaxValue : Instant.FromUnixTimeMilliseconds(endMs),
      Offset.FromSeconds(wallOffsetSeconds),
      Offset.FromSeconds(wallOffsetSeconds - standardOffsetSeconds),
    );
  }

  /** The last transition in or before the given year, or null if there isn't one. */
  private FindPreviousTransition(fromYear: number): number | null {
    for (let year = Math.min(fromYear, MaxProbeYear); year >= MinProbeYear; year--) {
      if (year > FinalRuleYear && this.IsFixedAfterFinalRuleYear()) {
        // No transitions between FinalRuleYear and this year.
        year = FinalRuleYear + 1;
        continue;
      }
      const transitions = this.GetYearData(year).Transitions;
      if (transitions.length > 0) {
        return transitions[transitions.length - 1]!.Milliseconds;
      }
    }
    return null;
  }

  /** The first transition in or after the given year, or null if there isn't one. */
  private FindNextTransition(fromYear: number): number | null {
    for (let year = Math.max(fromYear, MinProbeYear); year <= MaxProbeYear; year++) {
      if (year > FinalRuleYear && this.IsFixedAfterFinalRuleYear()) {
        return null;
      }
      const transitions = this.GetYearData(year).Transitions;
      if (transitions.length > 0) {
        return transitions[0]!.Milliseconds;
      }
    }
    return null;
  }

  private IsFixedAfterFinalRuleYear(): boolean {
    return this.GetYearData(FinalRuleYear).Transitions.length === 0;
  }

  private GetYearData(year: number): YearData {
    let data = this._years.get(year);
    if (data === undefined) {
      data = this.ComputeYearData(year);
      this._years.set(year, data);
    }
    return data;
  }

  private ComputeYearData(year: number): YearData {
    if (year > FinalRuleYear) {
      const finalYear = this.GetYearData(FinalRuleYear);
      if (finalYear.Transitions.length === 0) {
        return finalYear;
      }
    }
    const probe = this._probe;
    const end = UtcYearStart(year + 1);
    const transitions: ProbedTransition[] = [];
    // Sample (start - 1, ..., end - 1], so that a transition exactly at the start of the year belongs to this year.
    let previousMs = UtcYearStart(year) - 1;
    let previousOffset = probe.OffsetSecondsAt(previousMs);
    const startOffsetSeconds = previousOffset;
    while (previousMs < end - 1) {
      const nextMs = Math.min(previousMs + ProbeStepMilliseconds, end - 1);
      const nextOffset = probe.OffsetSecondsAt(nextMs);
      let lo = previousMs;
      let loOffset = previousOffset;
      while (loOffset !== nextOffset) {
        // Binary search (lo, nextMs] for the first millisecond whose offset differs from loOffset.
        let hi = nextMs;
        let hiOffset = nextOffset;
        while (hi - lo > 1) {
          const mid = lo + Math.floor((hi - lo) / 2);
          const midOffset = probe.OffsetSecondsAt(mid);
          if (midOffset === loOffset) {
            lo = mid;
          } else {
            hi = mid;
            hiOffset = midOffset;
          }
        }
        transitions.push({ Milliseconds: hi, OffsetSeconds: hiOffset });
        lo = hi;
        loOffset = hiOffset;
      }
      previousMs = nextMs;
      previousOffset = nextOffset;
    }
    return { StartOffsetSeconds: startOffsetSeconds, Transitions: transitions };
  }
}

/**
 * The zone interval map (uncached) of the host's Intl time zone with the given ID.
 * @throws {RangeError} The host doesn't support the given time zone ID.
 * @internal
 */
export function CreateIntlZoneIntervalMap(id: string): IZoneIntervalMap {
  return new IntlZoneIntervalMap(new IntlZoneProbe(id));
}

/** Whether the host has Intl.DateTimeFormat (time zone support is checked when a zone is created). @internal */
export function IsIntlAvailable(): boolean {
  return typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function";
}

/** Intl.supportedValuesOf("timeZone"), or [] where the host doesn't have it. @internal */
export function GetIntlSupportedTimeZones(): readonly string[] {
  // eslint-disable-next-line es-x/no-intl-supportedvaluesof -- feature-detected; without it the list is just the local zone
  return typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
}

/** The host's default time zone ID (Intl.DateTimeFormat().resolvedOptions().timeZone), or null. @internal */
export function GetIntlLocalId(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

/** The ID as the host canonicalizes it (e.g. "Asia/Kolkata" → "Asia/Calcutta" on ICU-based hosts), or null if the host doesn't accept it. @internal */
export function IntlCanonicalTimeZoneId(id: string): string | null {
  if (!IsIntlAvailable()) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: id }).resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

/** Whether the host's Intl accepts the time zone ID. @internal */
export function IsIntlTimeZoneId(id: string): boolean {
  return IntlCanonicalTimeZoneId(id) !== null;
}

/** The host's time zone data version, where it exposes one (Node's process.versions.tz), or "unknown". @internal */
export function GetIntlTimeZoneVersion(): string {
  // (Not globalThis, which is ES2020.)
  const versions = typeof process !== "undefined" ? process?.versions : undefined;
  return typeof versions?.tz === "string" ? versions.tz : "unknown";
}

/**
 * The host's English generic name for a zone (Intl's "longGeneric", e.g. "Australian Eastern Time"), or null where the
 * host doesn't have it.
 * @internal
 */
export function GetIntlGenericName(id: string): string | null {
  try {
    const format = new Intl.DateTimeFormat("en-US", { timeZone: id, timeZoneName: "longGeneric" });
    // eslint-disable-next-line es-x/no-intl-datetimeformat-prototype-formattoparts -- noda-js/system's Intl fallback needs formatToParts (ES2017 Intl)
    const part = format.formatToParts(0).find((p) => p.type === "timeZoneName");
    return part?.value ?? null;
  } catch {
    return null;
  }
}
