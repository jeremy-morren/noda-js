// Ported from NodaTime 3.3.7: src/NodaTime.Test/TimeZones/TzdbDateTimeZoneSourceTest.cs
// Copyright 2009 The Noda Time Authors. All rights reserved.
// Use of this source code is governed by the Apache License 2.0,
// as found in the LICENSE.txt file.
//
// noda-js: TzdbDateTimeZoneSource.Default is `tzdbSource` and DateTimeZoneProviders.Tzdb is `tzdb`, from the
// noda-js/tzdb/bundled entry point. The bundled data is tzdb 2026f, whereas NodaTime 3.3.7's tests ran against its own
// embedded data: the tests below that make assumptions about the built-in data (aliases, locations, Windows mappings)
// hold for both. FromStream(Stream) is FromBytes(Uint8Array); the embedded test resource
// Tzdb2013bFromNodaTime1.1.nzd is a copy in test/fixtures. Internal constructors are the static factories
// TzdbStreamData.NewBuilder, TzdbDateTimeZoneSource.NewSource, TzdbStreamField.NewIdData and
// WindowsZones.NewVersionTzdbVersionWindowsVersionMapZones; TzdbStreamData.Builder is TzdbStreamDataBuilder.
// Aliases is a ReadonlyMap rather than an ILookup, so a canonical ID with no aliases has no entry (rather than an
// empty group). MapTimeZoneInfoId takes an IHostTimeZone (an ID and UTC offsets) rather than a TimeZoneInfo.

/// <reference types="vite/client" />
import { expect } from "vitest";
// A data: URL (Vite inlines the file), so the bytes load the same way on Node and in browsers.
import nodaTime11NzdUrl from "../../fixtures/Tzdb2013bFromNodaTime1.1.nzd?inline";
import {
  DateTimeZone,
  Instant,
  InvalidNodaDataException,
  LocalDateTime,
  MapZone,
  NodaConstants,
  Offset,
  TzdbDateTimeZoneSource,
  TzdbStreamData,
  TzdbStreamDataBuilder,
  TzdbStreamField,
  TzdbStreamFieldId,
  TzdbZone1970Location,
  TzdbZone1970LocationCountry,
  TzdbZoneLocation,
  WindowsZones,
  ZonedDateTime,
} from "../../../src/noda-js/internal.ts";
import type { IHostTimeZone } from "../../../src/noda-js/TimeZones/HostTimeZone.ts";
import { tzdb, tzdbSource } from "../../../src/noda-js/entries/tzdb-bundled.ts";
import { assertNodaEqual, assertThrows } from "../../helpers/assertions.ts";
import { port } from "../../helpers/scenarios.ts";
import { TestHelper } from "../../helpers/TestHelper.ts";
import { fixture } from "../../scenarios/TimeZones/TzdbDateTimeZoneSourceTest.generated.ts";

function newWindowsZones(mapZones: MapZone[]): WindowsZones {
  return WindowsZones.NewVersionTzdbVersionWindowsVersionMapZones("cldr-version", "tzdb-version", "windows-version", mapZones);
}

/** LINQ Single(predicate). */
function single<T>(items: readonly T[], predicate: (item: T) => boolean): T {
  const matches = items.filter(predicate);
  expect(matches.length, "Single: number of matching elements").toBe(1);
  return matches[0]!;
}

/** NUnit's Assert.AreEqual(double expected, double actual, double delta). */
function assertAreEqualWithin(actual: number, expected: number, delta: number): void {
  expect(Math.abs(expected - actual), `expected ${expected} +/- ${delta} but was ${actual}`).toBeLessThanOrEqual(delta);
}

/** CollectionAssert.AreEquivalent on two dictionaries: the same key/value pairs, in any order. */
function assertMapsEquivalent(actual: ReadonlyMap<string, string>, expected: ReadonlyMap<string, string>): void {
  const sorted = (map: ReadonlyMap<string, string>) => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  expect(sorted(actual)).toEqual(sorted(expected));
}

/**
 * Creates a sample builder with two canonical zones (zone1 and zone2), and a link from zone3 to zone1.
 * There's a single Windows mapping territory, but no zone locations.
 */
function createSampleBuilder(): TzdbStreamDataBuilder {
  const builder = new TzdbStreamDataBuilder();
  builder._stringPool = [];
  builder._tzdbIdMap = new Map([["zone3", "zone1"]]);
  builder._tzdbVersion = "tzdb-version";
  builder._windowsMapping = newWindowsZones([new MapZone("windows-id", MapZone.PrimaryTerritory, ["zone1"]), new MapZone("windows-id", "UK", ["zone1"])]);
  populateZoneFields(builder, "zone1", "zone2");
  return builder;
}

function populateZoneFields(builder: TzdbStreamDataBuilder, ...zoneIds: string[]): void {
  for (const id of zoneIds) {
    builder._zoneFields.set(id, TzdbStreamField.NewIdData(TzdbStreamFieldId.TimeZone, new Uint8Array(0)));
  }
}

function assertInvalid(builder: TzdbStreamDataBuilder): void {
  const streamData = TzdbStreamData.NewBuilder(builder);
  const source = TzdbDateTimeZoneSource.NewSource(streamData);
  assertThrows(InvalidNodaDataException, () => source.Validate());
}

/**
 * Creates a time zone source with everything required to test the maps between
 * Windows and TZDB IDs. Details (not in XML) in the source...
 */
function createComplexMappingSource(): TzdbDateTimeZoneSource {
  // Canonical IDs: zone1, zone2, zone3, zone4, zone5, zone6
  // Aliases, linked to the obvious corresponding IDs: link1, link2, link3a, link3b, link3c
  // Windows mappings:
  // win1: zone1 (primary, UK)
  // win2: link2 (primary, UK)
  // win3: link3a (primary, UK)
  // win4: zone4 (primary, UK), zone5 (FR), link3b (CA)
  const builder = new TzdbStreamDataBuilder();
  builder._stringPool = [];
  builder._tzdbIdMap = new Map([
    ["link1", "zone1"],
    ["link2", "zone2"],
    ["link3a", "zone3"],
    ["link3b", "zone3"],
    ["link3c", "zone3"],
  ]);
  builder._tzdbVersion = "tzdb-version";
  builder._windowsMapping = newWindowsZones([
    new MapZone("win1", MapZone.PrimaryTerritory, ["zone1"]),
    new MapZone("win1", "UK", ["zone1"]),
    new MapZone("win2", MapZone.PrimaryTerritory, ["link2"]),
    new MapZone("win2", "UK", ["link2"]),
    new MapZone("win3", MapZone.PrimaryTerritory, ["link3a"]),
    new MapZone("win3", "UK", ["link3a"]),
    new MapZone("win4", MapZone.PrimaryTerritory, ["zone4"]),
    new MapZone("win4", "UK", ["zone4"]),
    new MapZone("win4", "FR", ["zone5"]),
    new MapZone("win4", "CA", ["link3b"]),
  ]);
  populateZoneFields(builder, "zone1", "zone2", "zone3", "zone4", "zone5", "zone6");
  const source = TzdbDateTimeZoneSource.NewSource(TzdbStreamData.NewBuilder(builder));
  source.Validate();
  return source;
}

port(
  fixture,
  {
    /**
     * Tests that we can load (and exercise) the binary Tzdb resource file distributed with Noda Time 1.1.0.
     * This is effectively a black-box regression test that ensures that the stream format has not changed in a
     * way such that a custom tzdb compiled with ZoneInfoCompiler from 1.1 would become unreadable.
     */
    async CanLoadNodaTimeResourceFromOnePointOneRelease() {
      const bytes = await (await fetch(nodaTime11NzdUrl)).arrayBuffer();
      const source = TzdbDateTimeZoneSource.FromBytes(new Uint8Array(bytes));
      expect(source.VersionId).toBe("TZDB: 2013b (mapping: 8274)");

      const utc = Instant.FromUtc(2007, 8, 24, 9, 30, 0);

      // Test a regular zone with rules.
      const london = source.ForId("Europe/London");
      const inLondon = new ZonedDateTime(utc, london);
      let expectedLocal = new LocalDateTime(2007, 8, 24, 10, 30);
      assertNodaEqual(inLondon.LocalDateTime, expectedLocal);

      // Test a fixed-offset zone.
      const utcFixed = source.ForId("Etc/UTC");
      const inUtcFixed = new ZonedDateTime(utc, utcFixed);
      expectedLocal = new LocalDateTime(2007, 8, 24, 9, 30);
      assertNodaEqual(inUtcFixed.LocalDateTime, expectedLocal);

      // Test an alias.
      const jersey = source.ForId("Japan"); // Asia/Tokyo
      const inJersey = new ZonedDateTime(utc, jersey);
      expectedLocal = new LocalDateTime(2007, 8, 24, 18, 30);
      assertNodaEqual(inJersey.LocalDateTime, expectedLocal);

      // Test ZoneLocations.
      const france = single(source.ZoneLocations!, g => g.CountryName === "France");
      // Tolerance of about 2 seconds
      assertAreEqualWithin(france.Latitude, 48.86666, 0.00055);
      assertAreEqualWithin(france.Longitude, 2.3333, 0.00055);
      expect(france.ZoneId).toBe("Europe/Paris");
      expect(france.CountryCode).toBe("FR");
      expect(france.Comment).toBe("");
    },

    /**
     * Simply tests that every ID in the built-in database can be fetched. This is also
     * helpful for diagnostic debugging when we want to check that some potential
     * invariant holds for all time zones...
     */
    ForId_AllIds() {
      const source = tzdbSource;
      for (const id of source.GetIds()) {
        expect(source.ForId(id)).not.toBeNull();
      }
    },

    ForId_Null() {
      assertThrows("ArgumentNullException", () => tzdbSource.ForId(null!));
    },

    ForId_Unknown() {
      TestHelper.assertInvalid(() => tzdbSource.ForId("unknown"));
    },

    UtcEqualsBuiltIn() {
      const zone = tzdbSource.ForId("UTC");
      assertNodaEqual(zone, DateTimeZone.Utc);
    },

    // The following tests all make assumptions about the built-in TZDB data.
    // This is simpler than constructing fake data, and validates that the creation
    // mechanism matches the reading mechanism, too.
    Aliases() {
      const aliases = tzdbSource.Aliases;
      expect([...aliases.get("Europe/London")!]).toEqual(["Europe/Belfast", "Europe/Guernsey", "Europe/Isle_of_Man", "Europe/Jersey", "GB", "GB-Eire"]);
      const london = aliases.get("Europe/London")!;
      expect([...london].sort()).toEqual([...london]); // CollectionAssert.IsOrdered
      expect(aliases.get("Europe/Jersey") ?? []).toEqual([]);
    },

    CanonicalIdMap_Contents() {
      const map = tzdbSource.CanonicalIdMap;
      expect(map.get("Europe/Jersey")).toBe("Europe/London");
      expect(map.get("Europe/London")).toBe("Europe/London");
    },

    // Sample zone location checks to ensure we've serialized and deserialized correctly
    // Input line: FR	+4852+00220	Europe/Paris
    ZoneLocations_ContainsFrance() {
      const zoneLocations = tzdbSource.ZoneLocations!;
      const france = single(zoneLocations, g => g.CountryName === "France");
      // Tolerance of about 2 seconds
      assertAreEqualWithin(france.Latitude, 48.86666, 0.00055);
      assertAreEqualWithin(france.Longitude, 2.3333, 0.00055);
      expect(france.ZoneId).toBe("Europe/Paris");
      expect(france.CountryCode).toBe("FR");
      expect(france.Comment).toBe("");
    },

    // Sample zone location checks to ensure we've serialized and deserialized correctly
    // Input line: GB,GG,IM,JE	+513030-0000731	Europe/London
    Zone1970Locations_ContainsBritain() {
      const zoneLocations = tzdbSource.Zone1970Locations!;
      const britain = single(zoneLocations, g => g.ZoneId === "Europe/London");
      // Tolerance of about 2 seconds
      assertAreEqualWithin(britain.Latitude, 51.5083, 0.00055);
      assertAreEqualWithin(britain.Longitude, -0.1253, 0.00055);
      expect(britain.ZoneId).toBe("Europe/London");
      assertNodaEqual(
        [...britain.Countries],
        [
          new TzdbZone1970LocationCountry("Britain (UK)", "GB"),
          new TzdbZone1970LocationCountry("Guernsey", "GG"),
          new TzdbZone1970LocationCountry("Isle of Man", "IM"),
          new TzdbZone1970LocationCountry("Jersey", "JE"),
        ],
      );
      expect(britain.Comment).toBe("");
    },

    // Input line: CA	+744144-0944945	America/Resolute	Central - NU (Resolute)
    // (Note: prior to 2016b, this was "Central Time - Resolute, Nunavut".)
    // (Note: prior to 2014f, this was "Central Standard Time - Resolute, Nunavut".)
    ZoneLocations_ContainsResolute() {
      const zoneLocations = tzdbSource.ZoneLocations!;
      const resolute = single(zoneLocations, g => g.ZoneId === "America/Resolute");
      // Tolerance of about 2 seconds
      assertAreEqualWithin(resolute.Latitude, 74.69555, 0.00055);
      assertAreEqualWithin(resolute.Longitude, -94.82916, 0.00055);
      expect(resolute.CountryName).toBe("Canada");
      expect(resolute.CountryCode).toBe("CA");
      expect(resolute.Comment).toBe("Central - NU (Resolute)");
    },

    TzdbVersion() {
      const source = tzdbSource;
      expect(source.TzdbVersion.startsWith("20")).toBe(true);
    },

    FixedDateTimeZoneName() {
      const zulu = tzdb.Get("Etc/Zulu");
      expect(zulu.GetZoneInterval(NodaConstants.UnixEpoch).Name).toBe("UTC");
    },

    VersionId() {
      const source = tzdbSource;
      expect(source.VersionId.startsWith(`TZDB: ${source.TzdbVersion}`)).toBe(true);
    },

    ValidateDefault() {
      tzdbSource.Validate();
    },

    LocalZoneIsNull() {
      // C#: replaces TimeZoneInfo.Local with null, then calls GetSystemDefaultId(), which maps TimeZoneInfo.Local
      // with MapTimeZoneInfoId. noda-js reads the system zone from TZ, Intl and Date, which can't be replaced, so this
      // checks the mapping of a null system zone directly.
      // If we have no system time zone, we have no ID to map it to.
      expect(tzdbSource.MapTimeZoneInfoId(null)).toBeNull();
    },

    MapTimeZoneInfoId(timeZoneInfoId: string, standardUtc: number, expectedId: string) {
      // C#: TimeZoneInfo.CreateCustomTimeZone(timeZoneInfoId, TimeSpan.FromHours(standardUtc), ...): a fixed zone.
      const zoneInfo: IHostTimeZone = { Id: timeZoneInfoId, FromEnvironment: false, GetUtcOffset: () => Offset.FromHours(standardUtc) };
      const source = tzdbSource;
      const mappedId = source.MapTimeZoneInfoId(zoneInfo);
      expect(mappedId).toBe(expectedId);

      // Do it again, and expect to get the same result again.
      // In the case of the "Lilo and Stitch" zone, this means hitting the cache rather than guessing
      // via transitions again.
      expect(source.MapTimeZoneInfoId(zoneInfo)).toBe(mappedId);
    },

    CanonicalIdMapValueIsNotAKey() {
      const builder = createSampleBuilder();
      builder._tzdbIdMap!.set("zone3", "missing-zone");
      assertInvalid(builder);
    },

    CanonicalIdMapValueIsNotCanonical() {
      const builder = createSampleBuilder();
      builder._tzdbIdMap!.set("zone4", "zone3"); // zone3 is an alias for zone1
      assertInvalid(builder);
    },

    WindowsMappingWithoutPrimaryTerritory() {
      const builder = createSampleBuilder();
      builder._windowsMapping = newWindowsZones([new MapZone("windows-id", "nonprimary", ["zone1", "zone2"])]);
      assertInvalid(builder);
    },

    WindowsMappingPrimaryTerritoryNotInNonPrimary() {
      const builder = createSampleBuilder();
      builder._windowsMapping = newWindowsZones([new MapZone("windows-id", MapZone.PrimaryTerritory, ["zone1"]), new MapZone("windows-id", "UK", ["zone2"])]);
      assertInvalid(builder);
    },

    WindowsMappingUsesMissingId() {
      const builder = createSampleBuilder();
      builder._windowsMapping = newWindowsZones([new MapZone("windows-id", MapZone.PrimaryTerritory, ["zone4"]), new MapZone("windows-id", "UK", ["zone4"])]);
      assertInvalid(builder);
    },

    WindowsMappingContainsDuplicateTzdbIds_SameTerritory() {
      const builder = createSampleBuilder();
      builder._windowsMapping = newWindowsZones([
        new MapZone("windows-id", MapZone.PrimaryTerritory, ["zone1"]),
        new MapZone("windows-id", "UK", ["zone1"]),
        new MapZone("windows-id", "CA", ["zone2", "zone2"]),
      ]);
      assertInvalid(builder);
    },

    WindowsMappingContainsDuplicateTzdbIds_SameWindowsIdDifferentTerritory() {
      const builder = createSampleBuilder();
      builder._windowsMapping = newWindowsZones([
        new MapZone("windows-id", MapZone.PrimaryTerritory, ["zone1"]),
        new MapZone("windows-id", "UK", ["zone1"]),
        new MapZone("windows-id", "CA", ["zone1"]),
      ]);
      assertInvalid(builder);
    },

    WindowsMappingContainsDuplicateTzdbIds_DifferentTerritories() {
      const builder = createSampleBuilder();
      builder._windowsMapping = newWindowsZones([
        new MapZone("windows-id1", MapZone.PrimaryTerritory, ["zone1"]),
        new MapZone("windows-id1", "CA", ["zone1"]),
        new MapZone("windows-id2", MapZone.PrimaryTerritory, ["zone1"]),
        new MapZone("windows-id2", "UK", ["zone1"]),
      ]);
      assertInvalid(builder);
    },

    WindowsMappingContainsWindowsIdWithNoPrimaryTerritory() {
      const builder = createSampleBuilder();
      builder._windowsMapping = newWindowsZones([new MapZone("windows-id1", "CA", ["zone1"])]);
      assertInvalid(builder);
    },

    WindowsMappingContainsWindowsIdWithDuplicateTerritories() {
      const builder = createSampleBuilder();
      builder._windowsMapping = newWindowsZones([
        new MapZone("windows-id1", MapZone.PrimaryTerritory, ["zone1"]),
        new MapZone("windows-id1", "CA", ["zone2"]),
        new MapZone("windows-id1", "CA", ["zone3"]),
      ]);
      assertInvalid(builder);
    },

    ZoneLocationsContainsMissingId() {
      const builder = createSampleBuilder();
      builder._zoneLocations = [new TzdbZoneLocation(0, 0, "country", "xx", "zone4", "comment")];
      assertInvalid(builder);
    },

    Zone1970LocationsContainsMissingId() {
      const builder = createSampleBuilder();
      const country = new TzdbZone1970LocationCountry("country", "xx");
      builder.Zone1970Locations = [new TzdbZone1970Location(0, 0, [country], "zone4", "comment")];
      assertInvalid(builder);
    },

    WindowsToTzdbIds() {
      const source = createComplexMappingSource();
      const actual = source.WindowsToTzdbIds;
      const expected = new Map([
        ["win1", "zone1"],
        ["win2", "zone2"],
        ["win3", "zone3"],
        ["win4", "zone4"],
      ]);
      assertMapsEquivalent(actual, expected);
    },

    TzdbToWindowsIds() {
      const source = createComplexMappingSource();
      const actual = source.TzdbToWindowsIds;
      const expected = new Map([
        ["zone1", "win1"],
        ["link1", "win1"],
        ["zone2", "win2"],
        ["link2", "win2"],
        // No explicit zone3 mapping; link3a and link3b map to win3 and win4 respectively;
        // link3a "wins" as it's earlier lexicographically.
        ["zone3", "win3"],
        ["link3a", "win3"],
        // Explicit mapping to win4 from link3b.
        // This is unusual, but we handle it
        ["link3b", "win4"],
        // link3c isn't mentioned at all, so we use the canonical ID
        ["link3c", "win3"],
        ["zone4", "win4"],
        ["zone5", "win4"],
        // zone6 isn't mapped at all
      ]);
      assertMapsEquivalent(actual, expected);
    },

    // We'll need to adjust the documentation if either of these tests starts to fail.
    TzdbToWindowsIdDocumentationExamples() {
      const source = tzdbSource;
      const kolkata = "Asia/Kolkata";
      const calcutta = "Asia/Calcutta";
      const indiaStandardTime = "India Standard Time";

      const asmara = "Africa/Asmara";
      const eastAfricaStandardTime = "E. Africa Standard Time";
      const nairobi = "Africa/Nairobi";

      const allMappedIds = source.WindowsMapping.MapZones.flatMap(mz => [...mz.TzdbIds]);

      // Validate the claims about the source data
      expect(source.CanonicalIdMap.get(calcutta)).toBe(kolkata);
      expect(allMappedIds.includes(kolkata)).toBe(false);

      expect(source.CanonicalIdMap.get(asmara)).toBe(nairobi);
      expect(allMappedIds.includes(asmara)).toBe(false);

      // And the mappings
      const mapping = source.TzdbToWindowsIds;
      expect(mapping.get(kolkata)).toBe(indiaStandardTime);
      expect(mapping.get(asmara)).toBe(eastAfricaStandardTime);
    },

    // Asserts that my commentary is correct in https://github.com/nodatime/nodatime/pull/1393
    UtcMappings() {
      const source = tzdbSource;
      // Note: was Etc/GMT before CLDR v39.
      expect(source.WindowsToTzdbIds.get("UTC")).toBe("Etc/UTC");

      expect(source.TzdbToWindowsIds.get("Etc/UTC")).toBe("UTC");
      // We follow the link
      expect(source.TzdbToWindowsIds.get("Etc/GMT+0")).toBe("UTC");
    },

    WindowsToTzdbIdDocumentationExamples() {
      const source = tzdbSource;
      const kolkata = "Asia/Kolkata";
      const calcutta = "Asia/Calcutta";
      const indiaStandardTime = "India Standard Time";

      // Validate the claims about the source data
      expect(source.CanonicalIdMap.get(calcutta)).toBe(kolkata);
      expect(source.WindowsMapping.MapZones.flatMap(mz => [...mz.TzdbIds]).includes(kolkata)).toBe(false);

      // And the mapping
      const mapping = source.WindowsToTzdbIds;
      expect(mapping.get(indiaStandardTime)).toBe(kolkata);
    },

    CanonicalIdMap_IsReadOnly() {
      const map = tzdbSource.CanonicalIdMap as Map<string, string>;
      assertThrows("NotSupportedException", () => map.set("Foo", "Bar"));
    },
  },
  {
    skip: {
    },
  },
);
