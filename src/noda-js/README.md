# noda-js

A TypeScript port of [NodaTime](https://nodatime.org), the date and time library for .NET: the same types, the
same member names, and the same text and JSON formats.

```sh
npm i noda-js
```

```ts
import { Instant, LocalDate, LocalDatePattern, Duration } from "noda-js";
import { tzdb } from "noda-js/tzdb/bundled";
import { enAU } from "noda-js/cultures";

const date = new LocalDate(2024, 3, 1).PlusDays(30);
date.DayOfWeek;                                            // IsoDayOfWeek.Sunday
LocalDatePattern.Create("d MMMM uuuu", enAU).Format(date); // "31 March 2024"

const now = Instant.FromUtc(2024, 3, 31, 12, 0);
now.InZone(tzdb.Get("Australia/Sydney")).toString();       // "2024-03-31T23:00:00 Australia/Sydney (+11)"
Duration.FromHours(1.5).TotalMinutes;                      // 90
JSON.stringify(date);                                      // "\"2024-03-31\""
```

## Names

Members keep their C# names: properties are getters (`duration.TotalSeconds`, `Instant.MaxValue`), methods are
methods (`date.PlusDays(1)`). Members JS calls by name keep their JS names: `toString()`, `toJSON()` and
`static fromJSON()`, `valueOf()` (which throws, so `a < b` fails loudly: use `CompareTo`), and
`[Symbol.iterator]`. C# indexers (`provider["Europe/London"]`) are `Get(...)`.

## Entry points

| Import | Contents |
|---|---|
| `noda-js` | All of NodaTime's core types: `Instant`, `LocalDate`, `ZonedDateTime`, `Period`, patterns, `DateTimeZone`, the ISO, Gregorian, Julian and Coptic calendars, `SystemClock`, ... |
| `noda-js/tzdb/bundled` | `tzdb`: a time zone provider over the bundled IANA time zone database (the equivalent of `DateTimeZoneProviders.Tzdb`) |
| `noda-js/tzdb` | `TzdbDateTimeZoneSource`: load a newer NZD file at runtime (e.g. from nodatime.org) without bundling one |
| `noda-js/tzdb/compiler` | `CompileTzdb`, `CompileTzdbToNzd`, and the synchronous `CompileTzdbSync`, `CompileTzdbToNzdSync`: compile an IANA tzdata release at runtime into a time zone source or an NZD file, as NodaTime's TzdbCompiler does. The release can be a URL such as `https://data.iana.org/time-zones/tzdata-latest.tar.gz`, downloaded with `fetch` or a synchronous `XMLHttpRequest`. It can also be its bytes in any form, a `Blob`, or (async only) a `Request`, `Response` or stream |
| `noda-js/system` | `SystemDateTimeZoneProvider`: the host system's time zones (NodaTime's `DateTimeZoneProviders.Bcl`): on Windows, Windows' zones read as .NET's `TimeZoneInfo` reads them (via FFI); elsewhere, the host's `Intl` zones ([docs](https://github.com/jeremy-morren/noda-js/blob/main/docs/Timezones.md)) |
| `noda-js/windows` | Windows time zone IDs ↔ IANA IDs (CLDR's mapping) |
| `noda-js/cultures` | Every culture as a named export (`enAU`, `esES`, ...); bundles keep only the ones you import. The invariant culture is built in. `NodaCultureInfo.CurrentCulture` is the culture of the host's language, among the cultures the app uses. |
| `noda-js/cultures/all` | `import "noda-js/cultures/all"`: bundles and registers every culture, so `NodaCultureInfo.CurrentCulture` can return any of them |
| `noda-js/calendars/hebrew`, `/islamic`, `/persian`, `/umalqura`, `/badi` | The other calendar systems, under the names of the `CalendarSystem` members they replace (`HebrewCivil`, `GetIslamicCalendar`, `PersianSimple`, `UmAlQura`, `Badi`, ...), so bundles only contain the calendars an app uses; importing one also registers its calendars for `CalendarSystem.ForId` |
| `noda-js/calendars/all` | Every calendar system outside the core |
| `noda-js/testing` | `FakeClock` and test time zones, as in `NodaTime.Testing` |
| `noda-js/linq` | Comparers for [linq-to-typescript](https://github.com/arogozine/LinqToTypeScript): `from(durations).orderBy(d => d, DurationComparer)` ([docs](https://github.com/jeremy-morren/noda-js/blob/main/docs/linq.md)) |

## Compatibility

ES2015 with no polyfills and no `BigInt` (Chrome 51, Firefox 54, Safari 10, Edge 15); `noda-js/system`'s `Intl`
zones also need `Intl.DateTimeFormat.prototype.formatToParts` (Chrome 57, Firefox 51, Safari 11, Edge 18). ESM only, with
TypeScript types; side-effect free (except `noda-js/cultures/all` and `noda-js/calendars/*`, which register what they
contain), so bundlers drop what you don't use.

C# `long` results are `number`s (exact up to 2⁵³); `long` arguments accept a number or, for exact values beyond
2⁵³, a decimal string. The differences from NodaTime are listed in
[docs/api-differences.md](https://github.com/jeremy-morren/noda-js/blob/main/docs/api-differences.md).

## Companion package

[`noda-js-zod`](https://www.npmjs.com/package/noda-js-zod): zod schemas for NodaTime's JSON formats.

Licensed under Apache-2.0, like NodaTime. See NOTICE.txt for the data licences (IANA tzdb, Unicode CLDR).
