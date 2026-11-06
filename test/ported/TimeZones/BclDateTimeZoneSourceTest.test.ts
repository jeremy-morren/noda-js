// Ported from NodaTime 3.3.7: src/NodaTime.Test/TimeZones/BclDateTimeZoneSourceTest.cs
// Copyright 2012 The Noda Time Authors. All rights reserved.
// Use of this source code is governed by the Apache License 2.0,
// as found in the LICENSE.txt file.
//
// noda-js: BclDateTimeZoneSource is SystemDateTimeZoneSource (noda-js/system) and BclDateTimeZone is
// SystemDateTimeZone. The tests run against the host's own zones: on Windows under Node with node:ffi, Windows' zones
// (as on .NET); elsewhere, the host's Intl zones (with Windows IDs mapped by CLDR on Windows). TimeZoneInfo is
// noda-js's port; TimeZoneInfo.CreateCustomTimeZone takes the base offset as TimeSpan ticks.

import { expect } from "vitest";
import {
  DateTimeZone,
  DateTimeZoneCache,
  NodaConstants,
  Offset,
  SystemDateTimeZone,
  SystemDateTimeZoneSource,
  TimeSpanTicks,
  TimeZoneInfo,
} from "../../../src/noda-js/internal.ts";
import { assertThrows } from "../../helpers/assertions.ts";
import { UnsupportedValue } from "../../helpers/decode.ts";
import { port } from "../../helpers/scenarios.ts";
import { fixture } from "../../scenarios/TimeZones/BclDateTimeZoneSourceTest.generated.ts";
import { TimeZoneInfoReplacer } from "./TimeZoneInfoReplacer.ts";

port(fixture, {
  UtcDoesNotEqualBuiltIn() {
    const zone = new SystemDateTimeZoneSource().ForId("UTC");
    expect(DateTimeZone.Utc.Equals(zone)).toBe(false);
  },

  FixedOffsetDoesNotEqualBuiltIn() {
    // Only a few fixed zones are advertised by Windows. We happen to know this one
    // is wherever we run tests :)
    // Unfortunately, it doesn't always exist on Mono (at least not on the Raspberry Pi...)
    // noda-js: nor with IANA IDs (browsers, other operating systems).
    const id = "UTC-02";
    const source = new SystemDateTimeZoneSource();
    if (source.GetIds().indexOf(id) === -1) {
      // Ignore.When: skips the test.
      throw new UnsupportedValue(`Test assumes existence of BCL zone with ID: ${id}`);
    }

    const zone = source.ForId(id);
    expect(DateTimeZone.ForOffset(Offset.FromHours(-2)).Equals(zone)).toBe(false);
    expect(zone.Id).toBe(id);
    expect(zone.GetZoneInterval(NodaConstants.UnixEpoch).WallOffset.Equals(Offset.FromHours(-2))).toBe(true);
  },

  ForId_Invalid() {
    assertThrows("ArgumentException", () => new SystemDateTimeZoneSource().ForId("This will never be a valid ID"));
  },

  CanLookupLocalTimeZoneById() {
    // Note that this test can fail legitimately, as there are valid situations where TimeZoneInfo.Local returns
    // a time zone that is not one of the system time zones.  These are unlikely to be cases that we encounter
    // in practice, though.

    // Now that we have our BCL local time zone, we should be able to look it up in the source.

    const source = new SystemDateTimeZoneSource();
    const id = source.GetSystemDefaultId();
    expect(id).not.toBeNull();

    // These lines replicate how DateTimeZoneCache implements GetSystemDefault().
    expect(source.GetIds(), "BCL local time zone ID should be included in the source ID list").toContain(id);
    const zone = source.ForId(id!);

    expect(zone).not.toBeNull(); // though really we only need to test that the call above didn't throw.
  },

  // This is effectively a test for DateTimeZoneCache, but is particularly
  // important for the BclDateTimeZoneSource. See
  // https://github.com/nodatime/nodatime/issues/332
  ProviderReturnsBclDateTimeZoneForAllAdvertisedIds() {
    const source = new SystemDateTimeZoneSource();
    const provider = new DateTimeZoneCache(source);
    const nonBclZones = provider.Ids.map(id => provider.Get(id)).filter(zone => !(zone instanceof SystemDateTimeZone));
    expect(nonBclZones).toEqual([]);
  },

  LocalZoneIsNotSystemZone() {
    const systemZone = TimeZoneInfo.CreateCustomTimeZone("Normal zone", 0, "Display", "Standard");
    const localZone = TimeZoneInfo.CreateCustomTimeZone("Local zone not in system zones", 5 * TimeSpanTicks.PerHour, "Foo", "Bar");
    const dispose = TimeZoneInfoReplacer.Replace(localZone, systemZone);
    try {
      const source = new SystemDateTimeZoneSource();
      expect([...source.GetIds()]).toEqual([systemZone.Id]);

      // We can't look it up later, but we can still find it...
      expect(source.GetSystemDefaultId()).toBe(localZone.Id);
    } finally {
      dispose();
    }
  },

  LocalZoneIsNull() {
    const systemZone = TimeZoneInfo.CreateCustomTimeZone("Normal zone", 0, "Display", "Standard");
    const dispose = TimeZoneInfoReplacer.Replace(null, systemZone);
    try {
      const source = new SystemDateTimeZoneSource();
      expect(source.GetSystemDefaultId()).toBeNull();
      expect([...source.GetIds()]).toEqual([systemZone.Id]);
    } finally {
      dispose();
    }
  },
});
