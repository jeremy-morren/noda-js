// Ported from NodaTime 3.3.7: src/NodaTime.Test/TimeZones/BclDateTimeZoneTest.cs
// Copyright 2012 The Noda Time Authors. All rights reserved.
// Use of this source code is governed by the Apache License 2.0,
// as found in the LICENSE.txt file.
//
// noda-js: BclDateTimeZone is SystemDateTimeZone (noda-js/system), and TimeZoneInfo is noda-js's port of .NET's
// (DateTime and TimeSpan values are noda-js's minimal DateTime and TimeSpan ticks). The tests over every host zone
// (AllZoneTransitions, AllZonesEveryWeek, DisplayName, ...) are excluded from the scenarios: test/system/ compares
// every zone with NodaTime's BclDateTimeZone on Windows instead. TransitionAtMidnight reads
// "E. South America Standard Time" from a fake Windows registry with Windows' data (test/helpers/FakeWindowsTimeZoneApi.ts),
// so it runs everywhere; it doesn't check TimeZoneInfo.GetUtcOffset for UTC DateTimes (not ported).
// BclDateTimeZoneTest.LinuxAdjustmentRules is excluded: .NET Core on Unix's rules aren't ported.

import { expect } from "vitest";
import {
  DateTime,
  Instant,
  LocalDate,
  LocalDateTime,
  Offset,
  SystemDateTimeZone,
  TimeSpanTicks,
  TimeZoneInfo,
  TimeZoneInfoAdjustmentRule,
  TimeZoneInfoInterceptor,
  TimeZoneInfoTransitionTime,
  ZoneInterval,
} from "../../../src/noda-js/internal.ts";
import { TimeZoneInfoCachedData } from "../../../src/noda-js/System/TimeZoneInfo.Win32.ts";
import { tzdb } from "../../../src/noda-js/entries/tzdb-bundled.ts";
import { assertNodaEqual, assertThrows } from "../../helpers/assertions.ts";
import { ESouthAmericaZone, FakeWindowsTimeZoneApi } from "../../helpers/FakeWindowsTimeZoneApi.ts";
import { port } from "../../helpers/scenarios.ts";
import { fixture } from "../../scenarios/TimeZones/BclDateTimeZoneTest.generated.ts";
import { fixture as linuxFixture } from "../../scenarios/TimeZones/BclDateTimeZoneTest.LinuxAdjustmentRules.generated.ts";
import { TimeZoneInfoReplacer } from "./TimeZoneInfoReplacer.ts";

const Hours = (hours: number): number => hours * TimeSpanTicks.PerHour;

port(fixture, {
  ForSystemDefault() {
    // Assume that the local time zone doesn't change between two calls...
    const local = TimeZoneInfoInterceptor.Shim === null ? null : TimeZoneInfoInterceptor.Local;
    const nodaLocal1 = SystemDateTimeZone.ForSystemDefault();
    const nodaLocal2 = SystemDateTimeZone.ForSystemDefault();
    // Check it's actually the right zone
    // noda-js: without TimeZoneInfo (browsers, other operating systems), zones from Intl have no OriginalZone.
    expect(nodaLocal1.OriginalZone).toBe(local);
    // Check it's cached
    expect(nodaLocal2).toBe(nodaLocal1);
  },

  DateTimeMinValueStartRuleExtendsToBeginningOfTime() {
    const rules = [
      // Rule for the whole of time, with DST of 1 hour commencing on March 1st
      // and ending on September 1st.
      TimeZoneInfoAdjustmentRule.CreateAdjustmentRule(
        DateTime.MinValue, DateTime.MaxValue.Date, Hours(1),
        TimeZoneInfoTransitionTime.CreateFixedDateRule(DateTime.MinValue, 3, 1),
        TimeZoneInfoTransitionTime.CreateFixedDateRule(DateTime.MinValue, 9, 1)),
    ];
    const bclZone = TimeZoneInfo.CreateCustomTimeZone("custom", 0, "DisplayName", "Standard", "Daylight", rules);
    const nodaZone = SystemDateTimeZone.FromTimeZoneInfo(bclZone);
    // Standard time in February BC 101
    assertNodaEqual(nodaZone.GetUtcOffset(Instant.FromUtc(-100, 2, 1, 0, 0)), Offset.Zero);
    // Daylight time in July BC 101
    assertNodaEqual(nodaZone.GetUtcOffset(Instant.FromUtc(-100, 7, 1, 0, 0)), Offset.FromHours(1));
    // Standard time in October BC 101
    assertNodaEqual(nodaZone.GetUtcOffset(Instant.FromUtc(-100, 10, 1, 0, 0)), Offset.Zero);
  },

  AwkwardLeapYears() {
    // This mimics the data on Mono on Linux for Europe/Malta, where there's a BCL adjustment rule for
    // each rule for quite a long time. One of those years is 1948, and the daylight transition is February
    // 29th. That then fails when we try to build a ZoneInterval at the end of that year.
    // See https://github.com/nodatime/nodatime/issues/743 for more details. We've simplified this to just
    // a single rule here...
    const rules = [
      TimeZoneInfoAdjustmentRule.CreateAdjustmentRule(
        DateTime.Create(1948, 1, 1),
        DateTime.Create(1949, 1, 1).AddDays(-1),
        Hours(1),
        TimeZoneInfoTransitionTime.CreateFixedDateRule(DateTime.Create(1, 1, 1, 2, 0, 0), 2, 29),
        TimeZoneInfoTransitionTime.CreateFixedDateRule(DateTime.Create(1, 1, 1, 3, 0, 0), 10, 3)),
    ];

    const bclZone = TimeZoneInfo.CreateCustomTimeZone("Europe/Malta", 0, "Malta", "Standard", "Daylight", rules);
    const nodaZone = SystemDateTimeZone.FromTimeZoneInfo(bclZone);

    const expectedTransition1 = Instant.FromUtc(1948, 2, 29, 2, 0, 0);
    const expectedTransition2 = Instant.FromUtc(1948, 10, 3, 2, 0, 0); // 3am local time

    const zoneIntervalBefore = nodaZone.GetZoneInterval(Instant.FromUtc(1947, 1, 1, 0, 0));
    assertNodaEqual(zoneIntervalBefore,
      new ZoneInterval("Standard", Instant.BeforeMinValue, expectedTransition1, Offset.Zero, Offset.Zero));

    const daylightZoneInterval = nodaZone.GetZoneInterval(Instant.FromUtc(1948, 6, 1, 0, 0));
    assertNodaEqual(daylightZoneInterval,
      new ZoneInterval("Daylight", expectedTransition1, expectedTransition2, Offset.FromHours(1), Offset.FromHours(1)));

    const zoneIntervalAfter = nodaZone.GetZoneInterval(Instant.FromUtc(1949, 1, 1, 0, 0));
    assertNodaEqual(zoneIntervalAfter,
      new ZoneInterval("Standard", expectedTransition2, Instant.AfterMaxValue, Offset.Zero, Offset.Zero));
  },

  LocalZoneIsNull() {
    const systemZone = TimeZoneInfo.CreateCustomTimeZone("Normal zone", 0, "Display", "Standard");
    const dispose = TimeZoneInfoReplacer.Replace(null, systemZone);
    try {
      assertThrows("InvalidOperationException", () => SystemDateTimeZone.ForSystemDefault());
    } finally {
      dispose();
    }
  },

  FakeDaylightSavingTime() {
    // Linux time zones on Mono can have a strange situation with a "0 savings" adjustment rule to represent
    // "we want to change standard time but we can't".
    // See https://github.com/nodatime/nodatime/issues/746
    // Normally the odd rule would only be in place for a year, but it's simplest to just make it all the time.
    // We go into daylight savings at midday on March 10th, and out again at midday on September 25.

    // We should be able to use DateTime.MaxValue for dateEnd, but not in .NET 4.5 apparently.
    const rule = TimeZoneInfoAdjustmentRule.CreateAdjustmentRule(DateTime.MinValue, DateTime.Create(9999, 12, 31), 0,
      TimeZoneInfoTransitionTime.CreateFixedDateRule(DateTime.Create(1, 1, 1, 12, 0, 0), 3, 10),
      TimeZoneInfoTransitionTime.CreateFixedDateRule(DateTime.Create(1, 1, 1, 12, 0, 0), 9, 25));
    const bclZone = TimeZoneInfo.CreateCustomTimeZone("Nasty", Hours(4), "Display", "Standard", "Daylight", [rule]);
    const nodaZone = SystemDateTimeZone.FromTimeZoneInfo(bclZone);
    const winterInterval = nodaZone.GetZoneInterval(Instant.FromUtc(2017, 2, 1, 0, 0));
    const summerInterval = nodaZone.GetZoneInterval(Instant.FromUtc(2017, 6, 1, 0, 0));

    const expectedWinter = new ZoneInterval("Standard", Instant.FromUtc(2016, 9, 25, 8, 0), Instant.FromUtc(2017, 3, 10, 8, 0), Offset.FromHours(4), Offset.Zero);
    const expectedSummer = new ZoneInterval("Daylight", Instant.FromUtc(2017, 3, 10, 8, 0), Instant.FromUtc(2017, 9, 25, 8, 0), Offset.FromHours(4), Offset.FromHours(1));

    assertNodaEqual(winterInterval, expectedWinter);
    assertNodaEqual(summerInterval, expectedSummer);
  },

  // See https://github.com/nodatime/nodatime/issues/1524 for the background
  // It would be nice to test earlier dates (e.g. 1967 and 1998) where transitions
  // actually occurred on the first of the "next month", but the Windows database has very different
  // data from TZDB in those cases.
  TransitionAtMidnight() {
    // noda-js: the zone from a fake Windows registry with Windows' data (see the file comment).
    const bclZone = new TimeZoneInfoCachedData(new FakeWindowsTimeZoneApi([ESouthAmericaZone])).FindSystemTimeZoneById("E. South America Standard Time");
    const nodaTzdbZone = tzdb.Get("America/Sao_Paulo");
    const nodaBclZone = SystemDateTimeZone.FromTimeZoneInfo(bclZone);

    // Brazil in 2012:
    // Fall back from -02:00 to -03:00 at midnight on February 26th
    const expectedFallBack = Instant.FromUtc(2012, 2, 26, 2, 0, 0);
    // Spring forward from -03:00 to -02:00 at midnight on October 21st
    const expectedSpringForward = Instant.FromUtc(2012, 10, 21, 3, 0, 0);
    // This is an arbitrary instant between the fall back and spring forward.
    const betweenTransitions = Instant.FromUtc(2012, 6, 1, 0, 0, 0);

    // Check that these transitions are as expected when we use TZDB.
    const nodaTzdbInterval = nodaTzdbZone.GetZoneInterval(betweenTransitions);
    assertNodaEqual(nodaTzdbInterval.Start, expectedFallBack);
    assertNodaEqual(nodaTzdbInterval.End, expectedSpringForward);

    // Not ported: checking that the real BCL time zone behaves as reported in the issue (TimeZoneInfo.GetUtcOffset
    // for UTC DateTimes, which noda-js's TimeZoneInfo doesn't have).

    // Assert that Noda Time accounts for the Windows time zone data weirdness, and corrects it to
    // a transition at midnight.
    const nodaBclInterval = nodaBclZone.GetZoneInterval(betweenTransitions);
    assertNodaEqual(nodaBclInterval.Start, nodaTzdbInterval.Start);
    assertNodaEqual(nodaBclInterval.End, nodaTzdbInterval.End);

    // Finally check the use case that was actually reported
    const actualStartOfDayAfterSpringForward = nodaBclZone.AtStartOfDay(new LocalDate(2012, 10, 21));
    const expectedStartOfDayAfterSpringForward = new LocalDateTime(2012, 10, 21, 1, 0, 0).InZoneStrictly(nodaBclZone);
    assertNodaEqual(actualStartOfDayAfterSpringForward, expectedStartOfDayAfterSpringForward);
  },
});

port(linuxFixture, {});
