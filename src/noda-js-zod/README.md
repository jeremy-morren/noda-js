# noda-js-zod

[Zod](https://zod.dev) schemas for [noda-js](https://www.npmjs.com/package/noda-js), the TypeScript port of [NodaTime](https://nodatime.org).
They validate NodaTime's JSON wire formats (as written by `NodaTime.Serialization.SystemTextJson`, and by noda-js's `toJSON()`)
and parse them into noda-js values.

```sh
npm i noda-js-zod noda-js zod
```

Requires zod 4.1 or later: each schema is a zod [codec](https://zod.dev/codecs), so `.parse()` turns JSON into 
a noda-js value and `.encode()` turns the value back into JSON. Parsing and formatting are noda-js's own 
(each type's `fromJSON()` and `toJSON()`), so the formats are exactly NodaTime's.

## Usage

```ts
import NodaZ from "noda-js-zod"; // or: import { NodaZ } from "noda-js-zod";
import { Instant } from "noda-js";

const instant = NodaZ.Instant.parse("2024-01-31T12:00:00Z"); // an Instant
instant.Equals(Instant.FromUtc(2024, 1, 31, 12, 0));         // true

NodaZ.Instant.encode(instant);                   // "2024-01-31T12:00:00Z"
NodaZ.LocalDate.parse("2024-02-29").PlusDays(1); // LocalDate 2024-03-01
NodaZ.Period.parse("P1Y2M").Months;              // 2
```

Invalid input is reported as zod issues, so `safeParse` returns them instead of throwing:

```ts
NodaZ.Instant.safeParse(1706702400000).error?.issues;
// [{
//   code: "invalid_type",
//   expected: "string",
//   path: [],
//   message: "Expected an Instant string in the format uuuu'-'MM'-'dd'T'HH':'mm':'ss;FFFFFFFFF'Z', but received number"
// }]

NodaZ.Instant.safeParse("2024-13-01T00:00:00Z").error?.issues;
// [{
//   code: "invalid_format",
//   format: "Instant",
//   pattern: "uuuu'-'MM'-'dd'T'HH':'mm':'ss;FFFFFFFFF'Z'",
//   path: [],
//   message: "The month 13 is out of range in year 2024. Value being parsed: '2024-13-01T00:00:00Z'."
// }]
```

### Time zones

`ZonedDateTime` and `DateTimeZone` values name a time zone, so their schemas are functions that take the
`IDateTimeZoneProvider` to look zone IDs up in. noda-js-zod never imports time-zone data itself; pass the provider
you use:

```ts
import { tzdb } from "noda-js/tzdb/bundled"; // or a provider from noda-js/tzdb, noda-js/system, ...

const ZonedDateTimeSchema = NodaZ.ZonedDateTime(tzdb); // create once, reuse
const meeting = ZonedDateTimeSchema.parse("2024-01-31T12:00:00+01 Europe/Madrid");
meeting.Zone.Id;                       // "Europe/Madrid"
ZonedDateTimeSchema.encode(meeting);   // "2024-01-31T12:00:00+01 Europe/Madrid"

NodaZ.DateTimeZone(tzdb).parse("America/New_York"); // tzdb.Get("America/New_York")
```

To read zones written by .NET's `BclDateTimeZone` (Windows IDs such as `AUS Eastern Standard Time`), pass a provider
wrapped in `WindowsIdDateTimeZoneProvider` from `noda-js/windows`.

### Calendars

JSON doesn't record a value's calendar system, so the reader has to know it. The schemas for types with a calendar
(`LocalDate`, `LocalDateTime`, `OffsetDate`, `OffsetDateTime`, `YearMonth`, `DateInterval`, and the schema
`ZonedDateTime(provider)` returns) read values in the ISO calendar. `.WithCalendar(calendar)` returns a new schema that
reads them in another calendar (the original is unchanged), as NodaTime.Serialization.SystemTextJson does with a
converter whose pattern uses that calendar:

```ts
import { CalendarSystem } from "noda-js";

const CopticDate = NodaZ.LocalDate.WithCalendar(CalendarSystem.Coptic); // create once, reuse
CopticDate.parse("1740-06-21");                       // 1740-06-21 in the Coptic calendar (29 February 2024)
NodaZ.LocalDate.parse("1740-06-21").Calendar;         // CalendarSystem.Iso: NodaZ.LocalDate is unchanged
NodaZ.ZonedDateTime(tzdb).WithCalendar(CalendarSystem.Julian);
```

## Schemas

Each schema is named after the noda-js type it produces. The wire format column is the pattern the type's
`fromJSON()` parses with (and `toJSON()` formats with), in NodaTime's pattern syntax.

| Schema | Input (JSON) | Wire format |
|---|---|---|
| `NodaZ.Instant` | string | `uuuu'-'MM'-'dd'T'HH':'mm':'ss;FFFFFFFFF'Z'` (`InstantPattern.ExtendedIso`) |
| `NodaZ.LocalDate` | string | `uuuu'-'MM'-'dd` (`LocalDatePattern.Iso`) |
| `NodaZ.LocalTime` | string | `HH':'mm':'ss;FFFFFFFFF` (`LocalTimePattern.ExtendedIso`) |
| `NodaZ.LocalDateTime` | string | `uuuu'-'MM'-'dd'T'HH':'mm':'ss;FFFFFFFFF` (`LocalDateTimePattern.ExtendedIso`) |
| `NodaZ.OffsetDateTime` | string | `uuuu'-'MM'-'dd'T'HH':'mm':'ss;FFFFFFFFFo<Z+HH:mm>` (`OffsetDateTimePattern.Rfc3339`) |
| `NodaZ.OffsetDate` | string | `uuuu'-'MM'-'ddo<G>` (`OffsetDatePattern.GeneralIso`) |
| `NodaZ.OffsetTime` | string | `HH':'mm':'ss;FFFFFFFFFo<G>` (`OffsetTimePattern.ExtendedIso`) |
| `NodaZ.Offset` | string | `g`: `+HH:mm:ss`, `+HH:mm` or `+HH`, the shortest that fits (`OffsetPattern.GeneralInvariant`) |
| `NodaZ.Duration` | string | `-H:mm:ss.FFFFFFFFF`, total hours (`DurationPattern.JsonRoundtrip`) |
| `NodaZ.Period` | string | ISO 8601 with extra `s`, `t` and `n` units: `P{years}Y{months}M{weeks}W{days}DT{hours}H{minutes}M{seconds}S{milliseconds}s{ticks}t{nanoseconds}n`, every unit optional (`PeriodPattern.Roundtrip`) |
| `NodaZ.YearMonth` | string | `uuuu'-'MM` (`YearMonthPattern.Iso`) |
| `NodaZ.AnnualDate` | string | `MM'-'dd` (`AnnualDatePattern.Iso`) |
| `NodaZ.Interval` | object | `{ start?, end? }`, each an `Instant` string; a missing property means unbounded that way |
| `NodaZ.DateInterval` | object | `{ start, end }`, each a `LocalDate` string (both inclusive) |
| `NodaZ.ZonedDateTime(provider)` | string | `uuuu'-'MM'-'dd'T'HH':'mm':'ss;FFFFFFFFFo<G> z`: the offset, a space, then the zone ID |
| `NodaZ.DateTimeZone(provider)` | string | the zone ID, one of the provider's `Ids` |

`Interval` and `DateInterval` match the property names case-insensitively, as noda-js's `fromJSON()` does, so
`{ "Start": ..., "End": ... }` (NodaTime's names without a camelCase naming policy) is accepted too; other
properties are ignored. `encode()` writes camelCase names.

For each schema, `z.input<typeof S>` is the JSON type and `z.output<typeof S>` the noda-js type. The exported
types `TextSchema<T>` and `ObjectSchema<J, T>` name the schemas' types, and `IntervalJson` / `DateIntervalJson`
the interval JSON shapes.

## Errors

All problems with the input are zod issues (never thrown exceptions), so `safeParse()` returns them with their
`path`, and `parse()` throws a `ZodError` holding them:

- **Not a string** (a number, `null`, `undefined`, an object, an array, ...): an `invalid_type` issue whose message
  names the type and the format it expects, taken from the pattern noda-js parses with:
  `Expected a LocalDate string in the format uuuu'-'MM'-'dd, but received null`.
  For `Interval` and `DateInterval`, input that isn't an object gets
  `Expected a DateInterval object with start and end properties, each a LocalDate string in the format uuuu'-'MM'-'dd, but received string`,
  and a bad property gets the message for its type at the property's path (`["start"]`).
- **A string noda-js can't parse**: an `invalid_format` issue (`format` is the type's name, `pattern` its pattern
  text) whose message is noda-js's own parse error, as NodaTime reports it, e.g.
  `The value string does not match the required number from the format string "uuuu". Value being parsed: '^bad'. (^ indicates error position.)`
  For `DateTimeZone`, it's the provider's message for an unknown ID.
- **A value noda-js rejects after parsing** (a `DateInterval` whose end is before its start): a `custom` issue with
  noda-js's message.

`encode()` checks its argument is the right noda-js type, with a `custom` issue such as
`Expected an Instant value, but received string`.

### Inside other schemas

The schemas are ordinary zod schemas, so they nest, and issues carry their path:

```ts
import * as z from "zod";
import NodaZ from "noda-js-zod";
import { tzdb } from "noda-js/tzdb/bundled";

const Booking = z.object({
  at: NodaZ.Instant,
  nights: z.array(NodaZ.LocalDate),
  stay: NodaZ.DateInterval,
  length: NodaZ.Period.optional(),
  zone: NodaZ.DateTimeZone(tzdb),
});
type Booking = z.output<typeof Booking>; // { at: Instant; nights: LocalDate[]; stay: DateInterval; ... }

const booking = Booking.parse(await response.json());
booking.stay.Length; // number of days

JSON.stringify(Booking.encode(booking)); // back to the wire format

const result = Booking.safeParse({ at: "2024-01-31T12:00:00Z", nights: ["2024-02-30"], stay: { start: "2024-02-01" }, zone: "Europe/Madrid" });
console.log(z.prettifyError(result.error!));
// ✖ The day 30 is out of range in month 2 of year 2024. Value being parsed: '2024-02-30'.
//   → at nights[0]
// ✖ Expected a LocalDate string in the format uuuu'-'MM'-'dd, but received undefined
//   → at stay.end
```

## Bundle size

`NodaZ` is the namespace of a module of named exports, and each schema is created in a side-effect-free
(`/* @__PURE__ */`) call. Bundlers that tree-shake namespace member accesses, such as Rollup (used by Vite),
keep only the schemas you use. esbuild keeps all of them when they're reached through the package
(it builds a re-exported namespace in full); they share their code, so that costs about 3 kB minified.

## License

Apache-2.0, like noda-js and NodaTime.
