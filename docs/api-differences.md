# API differences from NodaTime

noda-js follows NodaTime's public API with the mechanical changes in
[porting-conventions.md](porting-conventions.md).

**Names are the same as NodaTime's, PascalCase included**: types, methods, properties and enum members are
spelled exactly as in C# (`LocalDate.PlusDays`, `Duration.TotalSeconds`, `CalendarSystem.Iso`), so NodaTime code
and documentation carry over as written. The only camelCase members are the ones JavaScript itself calls by name:
`toString()`, `toJSON()`, `static fromJSON()`, `valueOf()` and `[Symbol.iterator]`; C# indexers (which have no name)
are `Get(...)` / `Set(...)`. Properties are getters, operators are named static methods (`Duration.Add`, `Instant.Subtract`), and
`Exception`s are `NodaError`s (below). This page lists everything else. The API test
(`test/api/api.test.ts`) checks the API shape against NodaTime by reflection, and its exceptions live
in `test/api/differences.ts`.

## Not ported

| Area | Reason / replacement |
|---|---|
| `CalendarSystem.HebrewCivil`, `HebrewScriptural`, `GetHebrewCalendar`, `GetIslamicCalendar`, `IslamicBcl`, `PersianSimple`, `PersianArithmetic`, `PersianAstronomical`, `UmAlQura`, `Badi` | Exported by the calendar entry points instead, under the same names, so that bundles only contain the calendars an app imports: `import { HebrewCivil } from "noda-js/calendars/hebrew"` (also `/islamic`, `/persian`, `/umalqura`, `/badi`, and `/all` for every one). Importing an entry point also registers its calendars, so `CalendarSystem.ForId` and `CalendarSystem.Ids` include them; `ForId` with the ID of one that isn't loaded throws `NotSupportedException` (which NodaTime documents for a calendar that's "known, but not supported on this platform"). ISO, Gregorian, Julian and Coptic are in `CalendarSystem` as in NodaTime. |
| `DateTimeZoneProviders` (static registry) | No global registry (tree shaking). Import a ready provider: `tzdb` from `noda-js/tzdb/bundled`, `SystemDateTimeZoneProvider` from `noda-js/system` (`DateTimeZoneProviders.Bcl`). |
| `BclDateTimeZone` and `BclDateTimeZoneSource` on .NET Core on Unix (`FromUnixAdjustmentRule`, `FixUnixTransitions`, `AreWindowsStyleRules`) | noda-js reads `TimeZoneInfo` data only from Windows; elsewhere `noda-js/system` uses `Intl` ([Timezones.md](Timezones.md)). |
| BCL interop: `DateTime`, `DateTimeOffset`, `TimeSpan`, `DateOnly`, `TimeOnly`, `TimeProvider`, `Stopwatch`, `System.DayOfWeek` members and extension classes | Replaced by JS `Date` interop: `Instant.FromJsDate(date)`, `instant.ToJsDate()` (millisecond precision). |
| `ClockExtensions.InTzdbSystemDefaultZone`, `InBclSystemDefaultZone` | Core can't depend on the providers; use `InZone(clock, tzdb.GetSystemDefault())` or `InZone(clock, SystemDateTimeZoneProvider.GetSystemDefault())`. |
| `XPattern.CreateWithCurrentCulture`, `NodaFormatInfo.CurrentInfo` | Pass a culture explicitly: one from `noda-js/cultures` (`import { enAU } from "noda-js/cultures"`), or the host's, `NodaCultureInfo.CurrentCulture`. |
| `ToString()` using the current culture | `toString()` uses the invariant culture; `toString(pattern, culture)` for anything else. |
| XML serialization, `TypeConverter`s, `HighPerformance` (`Instant64`, `Duration64`), `GetHashCode`, `Deconstruct` | .NET-specific. |
| `Duration.ToBigIntegerNanoseconds()`, `ToInt128Nanoseconds()`, `FromNanoseconds(BigInteger)`, `FromNanoseconds(Int128)` | No `BigInt` (the runtime baseline is ES2015). Within the `long` range, `ToInt64Nanoseconds()` and `FromNanoseconds("<decimal string>")` cover them; `TotalNanoseconds` gives the nearest double for any duration. |

## Changed

| NodaTime | noda-js | Why |
|---|---|---|
| `BclDateTimeZoneSource`, `BclDateTimeZone`, `DateTimeZoneProviders.Bcl` | `SystemDateTimeZoneSource`, `SystemDateTimeZone`, `SystemDateTimeZoneProvider` (`noda-js/system`). On Windows (with FFI or the native addon) they read Windows' zones exactly as on .NET, through a port of .NET's `TimeZoneInfo` (whose public members are `Id`, `DisplayName`, `StandardName`, `DaylightName`, `SupportsDaylightSavingTime`, `HasIanaId`); elsewhere they use the host's `Intl` zones (Windows IDs mapped by CLDR on Windows without FFI, IANA IDs otherwise), with no `OriginalZone`. `VersionId` names the backend. The TZ environment variable is honoured on every host (an unknown one means UTC). See [Timezones.md](Timezones.md). | No BCL in JS: the zones are the host system's. |
| `TzdbDateTimeZoneSource.GetSystemDefaultId` (`TimeZoneInfo.Local`) | The zone the TZ environment variable names, else the host's `Intl` zone, with `Date`'s offsets for `GuessZoneIdByTransitions` (so it works without `Intl` too). See [Timezones.md](Timezones.md#the-system-default-zone). | No `TimeZoneInfo.Local` outside `noda-js/system`, which tzdb doesn't depend on. |
| Indexer `PeriodBuilder[PeriodUnits]` | `builder.Get(unit)` / `builder.Set(unit, value)` | No indexers in JS. |
| Indexer `IDateTimeZoneProvider[string]` | `provider.Get(id)` | No indexers in JS. |
| `LocalDateTime.With(Func<LocalTime, LocalTime>)`, `OffsetDateTime.With(Func<LocalTime, LocalTime>)` | `WithTimeAdjuster(fn)` | Can't be told apart at runtime from `With(Func<LocalDate, LocalDate>)`, which keeps the name `With`. |
| `Instant.ToUnixTimeSecondsAndNanoseconds()` (tuple) | returns `{ seconds, nanoseconds }` | No tuples in JS. |
| C# `long` results that can exceed 2⁵³: `Duration.BclCompatibleTicks`, `ToInt64Nanoseconds()`, `Instant.ToUnixTimeTicks()` | `number`: exact up to 2⁵³, the nearest double beyond (the value is computed exactly, so overflow still throws `OverflowException` where C# does) | No `BigInt` in ES2015. |
| C# `long` arguments (`Duration.FromTicks`, `FromNanoseconds`, `Instant.FromUnixTimeTicks`, `PlusTicks`, `PlusNanoseconds`, `Period.FromHours` … `FromNanoseconds`, `PeriodBuilder` setters, `LocalTime.FromNanosecondsSinceMidnight`, `Offset.FromTicks`, ...) | accept `number \| string`: a safe integer, or a decimal string for an exact value anywhere in the `long` range (`Duration.FromNanoseconds("9223372036854775807")`). A string that isn't a decimal integer throws `FormatException`; one outside the `long` range throws `OverflowException`. | No `BigInt` in ES2015. |
| Overloads `Duration.FromDays(int)` / `FromDays(double)` etc. | one method; an integer argument takes the integer path, otherwise the `double` path | JS has one number type. `Duration.Divide(d, 2)` truncates like C# `d / 2L`. |
| `Period`'s `long` fields (hours … nanoseconds) | `number`; exact up to 2⁵³ | Values are stored exactly (as a 64-bit `Long` only beyond 2⁵³) and arithmetic is exact and checked, so overflow throws and formatting, parsing (`PT9223372036854775807H`), JSON and equality match C#, but the getters read values beyond 2⁵³ back as the nearest number (e.g. `Period.MaxValue.Hours` is 2⁶³). |
| `DateTimeZone.Equals` (reference equality from `object`) | `Equals(other)` | Explicit in JS; `FixedDateTimeZone` overrides it as NodaTime does. |
| `Equals(T)` and `Equals(object)`; `CompareTo(T)` and the explicit `IComparable.CompareTo(object)` | one `Equals(other)` / `CompareTo(other)` each, with a typed overload and an `unknown` one. `Equals` is false for anything that isn't the same type (never throws); `CompareTo` is positive for `null`/`undefined` and throws `ArgumentException` (C#'s message) for anything else. The built-in comparers (`OffsetDateTime.Comparer`, `ZonedDateTime.Comparer`, `Period.NormalizingEqualityComparer`, `Period.CreateComparer`, `ZoneEqualityComparer`) likewise return `false` from `Equals` and throw `ArgumentException` from `Compare` for a value of the wrong type. | JS can't overload on static types; C# accepts the `object` overloads too. |
| Error messages that print flag enums (`PeriodUnits`, `ZoneEqualityComparer.Options`) | print the numeric value | TS enums have no flag-name formatting. |
| Read-only collections (`TzdbDateTimeZoneSource.CanonicalIdMap`, `Aliases`, `ZoneLocations`, `WindowsZones.PrimaryMapping`, `MapZone.TzdbIds`, ...) | `ReadonlyMap` / `readonly T[]` that are also read-only at runtime: map mutators throw `NotSupportedException` (as .NET's `ReadOnlyDictionary` does); arrays are frozen, so mutating them throws a `TypeError` | |
| .NET exceptions (`ArgumentException`, `FormatException`, ...; NodaTime's `SkippedTimeException`, ...) | `NodaError`s. `Codes` is the .NET type's name (also `name`), then its base types' names (`["SkippedTimeException", "ArgumentOutOfRangeException", "ArgumentException", "SystemException"]`; `Exception` is implied). The .NET library's exceptions are types, not classes: check `e.Codes`, or `IsNodaError(e, "ArgumentException")`, which also matches derived types, as a C# catch clause does. NodaTime's own exceptions are classes derived from `NodaError`. | JS has no exception types to match .NET's, and checking a code works across bundles and realms. |
| `System.Globalization.CultureInfo` | `NodaCultureInfo` (`NodaCultureInfo.InvariantCulture`; the other cultures come from `noda-js/cultures`) | Holds only the data NodaTime reads, and the prefix keeps a generic BCL name out of app code and auto-imports. |

## Added

| Member | What |
|---|---|
| `toJSON()` / `static fromJSON()` on every value type | NodaTime.Serialization.SystemTextJson's formats. `Interval`/`DateInterval` write camelCase `start`/`end` and accept either case. `ZonedDateTime.fromJSON` and `DateTimeZone.fromJSON` take a provider. JSON doesn't record the calendar system, so `fromJSON` on `LocalDate`, `LocalDateTime`, `OffsetDate`, `OffsetDateTime`, `YearMonth`, `ZonedDateTime` and `DateInterval` takes an optional `calendar` (ISO if omitted), matching NodaTime converters built from a pattern with `WithCalendar`. A provider wrapped in `WindowsIdDateTimeZoneProvider` (`noda-js/windows`) reads the Windows zone IDs that .NET's `BclDateTimeZone` writes. |
| `NodaCultureInfo.CurrentCulture`, `NodaCultureInfo.Register(...cultures)` | CultureInfo.CurrentCulture's counterpart: the registered culture that best matches the host's languages (`navigator.languages`, or `Intl`'s default locale), throwing `InvalidOperationException` if none does. The cultures of `noda-js/cultures` register themselves when an app uses them; `Register` adds others. |
| `noda-js/cultures/all` | `import "noda-js/cultures/all"` bundles and registers every culture, so `CurrentCulture` knows them all. |
| `valueOf()` on value types | Throws `TypeError`, so `a < b` fails loudly. Use `CompareTo`/`Equals`. |
| `TzdbDateTimeZoneSource.FromBytes(Uint8Array)`, `FromBase64(text)` | Load NZD data (e.g. fetched from nodatime.org at runtime). |
| `DateInterval[Symbol.iterator]` | C#'s `IEnumerable<LocalDate>`. |
| `noda-js/windows`: `WindowsIdDateTimeZoneProvider`, `GetCldrWindowsZones()` | Accept Windows zone IDs, mapped to tzdb zones. |
| `noda-js/tzdb/compiler`: `CompileTzdb(source, options?)`, `CompileTzdbToNzd(source, options?)`, `CompileTzdbSync(source, options?)`, `CompileTzdbToNzdSync(source, options?)` | NodaTime.TzdbCompiler, a command-line tool, as library functions. They compile an IANA tzdata release, a `.tar.gz` or `.tar`, into a validated `TzdbDateTimeZoneSource`. The `ToNzd` variants return instead the NZD bytes NodaTime's compiler writes (identical, with the CLDR Windows mapping noda-js bundles). The release can be a URL: the async functions download it with `fetch`, and the sync ones with a synchronous `XMLHttpRequest`. Each throws `InvalidOperationException` if the host lacks that API. The release can also be its bytes in any form (`TzdataBytes`: typed arrays, `ArrayBuffer`/`SharedArrayBuffer`, `number[]`, lists of chunks) or a `Blob`/`File`. The async functions also take a `Request`, `Response`, `ReadableStream` or async iterable such as a Node.js stream (`TzdataSource`). An invalid archive throws `InvalidDataException`, which is exported too (System.IO.InvalidDataException). Options: `WindowsZones` (the compiler's `-w`) and `Log` (its console output). The compiler's other options (a single zone, XML schema output) and `tzdb-<version>.tar.lz` archives aren't supported. |
