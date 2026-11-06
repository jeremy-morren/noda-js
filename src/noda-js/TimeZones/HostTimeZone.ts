// noda-js: new code. The host's current time zone, as the tzdb source's GetSystemDefaultId sees it, standing in for
// TimeZoneInfo.Local in NodaTime's TzdbDateTimeZoneSource.MapTimeZoneInfoId: its ID (the TZ environment variable's, or
// the host's Intl default zone's), and its UTC offsets from the host's Date (for guessing the zone by its transitions
// when the ID doesn't map, including on hosts without Intl).

import { Offset } from "../internal.ts";
import type { Instant } from "../internal.ts";
import { GetTZEnvironmentVariable } from "../Utility/TimeZoneEnvironment.ts";

/**
 * The parts of a TimeZoneInfo that TzdbDateTimeZoneSource.MapTimeZoneInfoId uses: its ID and its UTC offsets.
 * @internal
 */
export interface IHostTimeZone {
  /** The zone's ID: a Windows ID, a tzdb ID, or "Local" when the host can't name it. */
  readonly Id: string;
  /** Whether the ID is the TZ environment variable's (then an ID that doesn't map isn't guessed: it means UTC). */
  readonly FromEnvironment: boolean;
  /** TimeZoneInfo.GetUtcOffset for an instant. */
  GetUtcOffset(instant: Instant): Offset;
}

/** The ID Mono's TimeZoneInfo.Local has when it can't name the zone; also noda-js's, without Intl. */
const LocalId = "Local";

/**
 * The host's current zone: named by the TZ environment variable if it's set, otherwise by the host's Intl default zone
 * (or "Local" without Intl), with the offsets the host's Date gives (getTimezoneOffset).
 * @internal
 */
export function GetHostTimeZone(): IHostTimeZone {
  const tz = GetTZEnvironmentVariable();
  const id = tz ?? GetIntlLocalId() ?? LocalId;
  return {
    Id: id,
    FromEnvironment: tz !== null,
    GetUtcOffset: DateUtcOffset,
  };
}

/** The host's local UTC offset at an instant, from Date (to the second). */
function DateUtcOffset(instant: Instant): Offset {
  const minutes = new Date(instant.ToUnixTimeMilliseconds()).getTimezoneOffset();
  return Offset.FromSeconds(-Math.round(minutes * 60));
}

function GetIntlLocalId(): string | null {
  try {
    return typeof Intl !== "undefined" ? (Intl.DateTimeFormat().resolvedOptions().timeZone ?? null) : null;
  } catch {
    return null;
  }
}
