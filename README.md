# noda-js

[![CI](https://github.com/jeremy-morren/noda-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jeremy-morren/noda-js/actions/workflows/ci.yml?query=branch%3Amain)
[![Release](https://img.shields.io/github/v/release/jeremy-morren/noda-js)](https://github.com/jeremy-morren/noda-js/releases/latest)
[![noda-js on npm](https://img.shields.io/npm/v/noda-js?label=noda-js)](https://www.npmjs.com/package/noda-js)
[![noda-js-zod on npm](https://img.shields.io/npm/v/noda-js-zod?label=noda-js-zod)](https://www.npmjs.com/package/noda-js-zod)
[![License](https://img.shields.io/github/license/jeremy-morren/noda-js)](LICENSE.txt)

A TypeScript port of [NodaTime](https://nodatime.org).

Test results and coverage: every [CI run](https://github.com/jeremy-morren/noda-js/actions/workflows/ci.yml) has them
in its summary (and pull requests get them as comments).

## Usage

```sh
npm i noda-js
```

### Construction and arithmetic

```ts
import { Duration, Instant, LocalDate, LocalTime, Period, SystemClock } from "noda-js";

const instant = Instant.FromUtc(2024, 3, 31, 12, 0);   // 2024-03-31T12:00:00Z
const now = SystemClock.Instance.GetCurrentInstant();
const fromDate = Instant.FromJsDate(new Date());       // and instant.ToJsDate()

const date = new LocalDate(2024, 3, 1);
const meeting = date.At(new LocalTime(9, 30));               // a LocalDateTime: 2024-03-01T09:30:00

const ninety = Duration.FromMinutes(90);
ninety.TotalHours;                                           // 1.5
instant.Plus(Duration.FromHours(36));                        // 2024-04-02T00:00:00Z
date.PlusMonths(1).PlusDays(-1);                             // 2024-03-31
Period.Between(new LocalDate(2024, 1, 31), date).toString(); // "P1M1D"
```

### Time zones

```ts
import { tzdb } from "noda-js/tzdb/bundled"; // the IANA time zone database, bundled

const madrid = tzdb.Get("Europe/Madrid");
instant.InZone(madrid);                    // 2024-03-31T14:00:00 Europe/Madrid (+02)
instant.InZone(madrid)
  .WithZone(tzdb.Get("Australia/Sydney")); // 2024-03-31T23:00:00 Australia/Sydney (+11)
madrid.GetUtcOffset(instant);              // +02

// Local date and time → a zoned value. 02:30 on 31 March 2024 doesn't exist in Madrid (the clocks went forward):
const gap = new LocalDate(2024, 3, 31).At(new LocalTime(2, 30));
gap.InZoneLeniently(madrid);                    // 2024-03-31T03:30:00 Europe/Madrid (+02)
gap.InZoneStrictly(madrid);                     // throws SkippedTimeException
meeting.InZoneLeniently(madrid).ToInstant();    // 2024-03-01T08:30:00Z
```

`CompileTzdbSync` is synchronous. `CompileTzdbToNzd` returns NZD bytes to cache for `TzdbDateTimeZoneSource.FromBytes`.

The host system's own zones (NodaTime's `DateTimeZoneProviders.Bcl`) are in `noda-js/system`: on Windows, Windows'
zones read exactly as .NET's `TimeZoneInfo` reads them (via `node:ffi`), elsewhere the host's `Intl` zones:

```ts
import { SystemDateTimeZoneProvider } from "noda-js/system";

SystemDateTimeZoneProvider.GetSystemDefault();     // "AUS Eastern Standard Time" on Windows, "Australia/Sydney" elsewhere
tzdb.GetSystemDefault();                           // Australia/Sydney (both honour the TZ environment variable)
```

All about the providers, the system default zone and Windows zones: [docs/Timezones.md](docs/Timezones.md).

### Formatting and parsing

```ts
import { LocalDatePattern, NodaCultureInfo } from "noda-js";
import { esES } from "noda-js/cultures"; // every culture is a named export; bundles keep only the ones you import

date.toString("d MMMM uuuu", null);                                  // "1 March 2024" (null: the invariant culture)
LocalDatePattern.Create("d 'de' MMMM 'de' uuuu", esES).Format(date); // "1 de marzo de 2024"

const result = LocalDatePattern.Iso.Parse("2024-02-30");
result.Success;                                          // false
result.Exception.message;                                // "The day 30 is out of range in month 2 of year 2024. ..."
LocalDatePattern.Iso.Parse("2024-02-29").Value;          // 2024-02-29

// The host's language: import "noda-js/cultures/all" (every culture), or import the cultures you support.
LocalDatePattern.Create("D", NodaCultureInfo.CurrentCulture).Format(date);
```

### Other calendar systems

ISO (the default), Gregorian, Julian and Coptic are in `CalendarSystem`. The others are separate imports, so apps only
bundle the calendars they use, under the names NodaTime gives them:

```ts
import { HebrewCivil } from "noda-js/calendars/hebrew";
import { GetIslamicCalendar } from "noda-js/calendars/islamic"; // also /persian, /umalqura, /badi, or /all
import { IslamicEpoch, IslamicLeapYearPattern } from "noda-js";

new LocalDate(2024, 3, 1).WithCalendar(HebrewCivil);                    // 21 Adar I 5784: year 5784, month 6, day 21
date.WithCalendar(GetIslamicCalendar(IslamicLeapYearPattern.Base16, IslamicEpoch.Civil));
```

### JSON

`toJSON()` and `fromJSON()` use the formats of NodaTime.Serialization.SystemTextJson, so values round-trip with .NET:

```ts
import { CalendarSystem, ZonedDateTime } from "noda-js";

JSON.stringify({ at: instant, on: date, zoned: instant.InZone(madrid) });
// {"at":"2024-03-31T12:00:00Z","on":"2024-03-01","zoned":"2024-03-31T14:00:00+02 Europe/Madrid"}
Instant.fromJSON("2024-03-31T12:00:00Z");
ZonedDateTime.fromJSON("2024-03-31T14:00:00+02 Europe/Madrid", tzdb);

// JSON doesn't record the calendar: values are read in the ISO calendar unless you pass another.
LocalDate.fromJSON("2024-03-01", CalendarSystem.Julian); // 1 March 2024 (Julian), which is 14 March (ISO)
```

With [zod](https://zod.dev) and `noda-js-zod`, a schema parses JSON (e.g. from a .NET API) straight into noda-js values:

```sh
npm i noda-js-zod
```

```ts
import * as z from "zod";
import NodaZ from "noda-js-zod";

const Booking = z.object({
  at: NodaZ.Instant,
  nights: z.array(NodaZ.LocalDate),
  zone: NodaZ.DateTimeZone(tzdb),
});

const booking = Booking.parse(await response.json());
booking.at.InZone(booking.zone);   // a ZonedDateTime
Booking.encode(booking);           // back to the JSON form

// The schemas read ISO values; .WithCalendar(calendar) returns a schema for another calendar (the original is unchanged).
const CopticDate = NodaZ.LocalDate.WithCalendar(CalendarSystem.Coptic);
CopticDate.parse("1740-06-21");    // 1740-06-21 in the Coptic calendar, which is 29 February 2024 (ISO)

Booking.safeParse({ at: 42, nights: ["2024-02-30"], zone: "Europe/Madrid" });
// ✖ Expected an Instant string in the format uuuu'-'MM'-'dd'T'HH':'mm':'ss;FFFFFFFFF'Z', but received number → at at
// ✖ The day 30 is out of range in month 2 of year 2024. Value being parsed: '2024-02-30'. → at nights[0]
```

#### Up-to-date time zones

Compile the latest IANA release at runtime with `noda-js/tzdb/compiler`:

```ts
import { CompileTzdb } from "noda-js/tzdb/compiler";

// On the server
const source = await CompileTzdb("https://data.iana.org/time-zones/tzdata-latest.tar.gz");

// In a browser (data.iana.org has no CORS):
const [latest] = await (await fetch("https://api.github.com/repos/eggert/tz/tags?per_page=1")).json();
const source = await CompileTzdb(`https://cdn.jsdelivr.net/gh/eggert/tz@${latest.name}/`);

const tzdbLatest = new DateTimeZoneCache(source);
```

## Packages

| Package                                    | What it is  | npm | GitHub Packages |
|--------------------------------------------|-------------|-----|-----------------|
| [`noda-js`](src/noda-js/README.md)         | The port itself: every NodaTime type, text patterns, time zones (bundled tzdb or the system's), cultures, testing helpers | [noda-js](https://www.npmjs.com/package/noda-js) | [@jeremy-morren/noda-js](https://github.com/jeremy-morren/noda-js/pkgs/npm/noda-js) |
| [`noda-js-zod`](src/noda-js-zod/README.md) | Zod schemas that parse NodaTime's JSON formats into noda-js values (`NodaZ.Instant`, ...) | [noda-js-zod](https://www.npmjs.com/package/noda-js-zod) | [@jeremy-morren/noda-js-zod](https://github.com/jeremy-morren/noda-js/pkgs/npm/noda-js-zod) |

GitHub Packages are prefixed with `@jeremy-morren/...`. noda-js-zod imports `"noda-js"`, 
so install the core from GitHub Packages under that name: `"noda-js": "npm:@jeremy-morren/noda-js@^0.2.0"`.

Both are published with npm provenance, so npm can verify each version was built from this repository by its CI.

## Runs anywhere

noda-js runs in any JavaScript environment: browsers, Node, Deno and Bun, and non-web environments such as embedded
or scripting engines. It needs only ES2015 (Chrome 51, Firefox 54, Safari 10, Edge 15): no polyfills and no `BigInt`.

It uses the host's own APIs where they're available, since those are likely optimised (`Intl` for culture-aware
comparisons and the host's languages, `TextDecoder`, `Uint8Array.fromBase64` / `atob`, `performance`,
`DecompressionStream`), and always has its own implementation to fall back on. Only two features need the host:
`noda-js/system` (the host's time zones: Windows' through FFI, or `Intl`'s; use the bundled tzdb elsewhere) and
`NodaCultureInfo.CurrentCulture` (the host's language; pass a culture elsewhere). (Compiling tzdata from a URL also
needs the host's `fetch`; pass the archive's bytes elsewhere.) The tests run on Node, Chromium, Firefox and WebKit,
without those APIs, and in [QuickJS](https://bellard.org/quickjs/), an embedded engine that has none of them.

### Without a bundler

Each [release](https://github.com/jeremy-morren/noda-js/releases/latest) has `noda-js-module-<version>.zip` and
`noda-js-module-<version>.tar.gz`: one ES module, `noda-js.js` (and its source map), with everything in the npm package (the
core, the bundled tzdb and the tzdb compiler, every culture, the system and Windows providers, the testing helpers and
the linq comparers), for a browser's `<script type="module">`, Deno, or an embedded engine that loads ES modules:

```html
<script type="module">
  import { Instant, tzdb } from "./noda-js.js";
  console.log(Instant.FromUtc(2024, 7, 1, 12, 0).InZone(tzdb.Get("Europe/Madrid")).toString());
</script>
```

It's about 160 KB gzipped: a bundler, which keeps only what an app uses, gives smaller apps.

The archives, `noda-js.js` and its source map have build provenance attestations, so you can check a copy was built
from this repository by its release workflow:
`gh attestation verify noda-js-module-<version>.zip --repo jeremy-morren/noda-js`.

C# `long` arguments accept a number or, for exact values beyond 2⁵³, a decimal string.
- Differences from NodaTime: [docs/api-differences.md](docs/api-differences.md)
- Time zones (providers, the system default, Windows): [docs/Timezones.md](docs/Timezones.md)
- How the port is written: [docs/porting-conventions.md](docs/porting-conventions.md)
- Tests: [test/README.md](test/README.md)

## Port

This is a line-by-line port of NodaTime. It aims for:

- **The same API, with the same names**: C# properties are getters (`duration.TotalSeconds`, `date.Year`,
  `Instant.MaxValue`), methods are methods (`date.PlusDays(1)`). Only what JS itself calls by name keeps its JS
  name: `toString()`, `toJSON()`/`fromJSON()`, `valueOf()`, `[Symbol.iterator]`.
- **The same wire formats**: text patterns, `toString()`, and JSON (`toJSON()` / `fromJSON()`) produce
  and accept what NodaTime (and `NodaTime.Serialization.SystemTextJson`) do.
- **As little of our own code as possible**: the source is a file-by-file port of NodaTime
  (`src/noda-js/Foo.ts` ← `src/NodaTime/Foo.cs`), and everything .NET can tell us (enums, constants, error
  messages, culture data, tzdb, the API shape, ~20,000 test cases) is generated from .NET by the tools
  in [`tools/`](tools/README.md).

## License

Licensed under Apache-2.0, like NodaTime. See [NOTICE.txt](NOTICE.txt) for data licences.
