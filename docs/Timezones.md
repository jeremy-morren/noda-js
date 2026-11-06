# Time zones

noda-js has NodaTime's time zone types (`DateTimeZone`, `ZoneInterval`, `IDateTimeZoneProvider`,
`DateTimeZoneCache`, ...) in its core, and the zones themselves in separate entry points, so apps only bundle the ones
they use. NodaTime's static registry, `DateTimeZoneProviders`, isn't ported: import a provider instead.

| Import | Provider | NodaTime |
|---|---|---|
| `noda-js/tzdb/bundled` | `tzdb` (and its source, `tzdbSource`): the IANA time zone database, bundled | `DateTimeZoneProviders.Tzdb`, `TzdbDateTimeZoneSource.Default` |
| `noda-js/tzdb` | `TzdbDateTimeZoneSource.FromBytes` / `FromBase64`: an NZD file loaded at run time (e.g. from nodatime.org), with no data bundled | `TzdbDateTimeZoneSource.FromStream` |
| `noda-js/tzdb/compiler` | `CompileTzdb(source)` and friends: an IANA tzdata release compiled at run time | NodaTime.TzdbCompiler (a command-line tool) |
| `noda-js/system` | `SystemDateTimeZoneProvider`, `SystemDateTimeZoneSource`, `SystemDateTimeZone`: the host system's own time zones | `DateTimeZoneProviders.Bcl`, `BclDateTimeZoneSource`, `BclDateTimeZone` |
| `noda-js/windows` | `WindowsIdDateTimeZoneProvider`: wraps a provider (normally tzdb) so it also accepts Windows zone IDs, mapped by CLDR | (none) |

```ts
import { tzdb } from "noda-js/tzdb/bundled";
import { SystemDateTimeZoneProvider } from "noda-js/system";

tzdb.Get("Australia/Sydney");
tzdb.GetSystemDefault();                         // e.g. Australia/Sydney
SystemDateTimeZoneProvider.GetSystemDefault();   // e.g. "AUS Eastern Standard Time" on Windows
```

Up-to-date tzdb data without a new noda-js release: see the README's
[Up-to-date time zones](../README.md#up-to-date-time-zones).

## The system provider (`noda-js/system`)

`SystemDateTimeZoneSource` is NodaTime's `BclDateTimeZoneSource`, renamed because JavaScript has no Base Class
Library: its zones are the host system's. `SystemDateTimeZoneProvider` is a `DateTimeZoneCache` over it (NodaTime's
`DateTimeZoneProviders.Bcl`), created on first use. `SystemDateTimeZone` is `BclDateTimeZone`, with `OriginalZone`
(a `TimeZoneInfo`), `DisplayName`, `FromTimeZoneInfo` and `ForSystemDefault`.

Where the zones come from is decided when the source is created (the provider's first use), by what the host
actually has, in this order:

| Backend | When | IDs | Rules |
|---|---|---|---|
| `"addon"` | Windows, with the native addon package installed (see below) | Windows IDs ("AUS Eastern Standard Time") | Windows' own, read as .NET's `TimeZoneInfo` reads them |
| `"ffi"` | Windows under Node 26+ (with `node:ffi`), Bun (`bun:ffi`) or Deno (with the FFI permission already granted) | Windows IDs | Windows' own, as .NET |
| `"intl"`, Windows | Windows under Node, Bun or Deno without either (older Node, `--no-experimental-ffi`, the permission model without `--allow-ffi`, ...) | Windows IDs, mapped from the host's IANA zones by CLDR's windowsZones | The host's `Intl` |
| `"intl"`, elsewhere | Browsers (on any OS, as .NET in a browser), Node, Bun and Deno on other operating systems, other hosts | IANA IDs ("Australia/Sydney") | The host's `Intl` |

`VersionId` says which: `"TimeZoneInfo: Windows (node:ffi)"` (or `bun:ffi`, `Deno FFI`, or the addon's package name)
when it reads Windows' zones; otherwise `"Intl: "` and the host's tz data version where it exposes one
(`process.versions.tz` on Node, e.g. `"Intl: 2025b"`; `"Intl: unknown"` elsewhere), followed on Windows by
`" (Windows IDs from CLDR windowsZones 49)"`.

Without Windows' data and without `Intl.DateTimeFormat` (an embedded engine such as QuickJS), the source throws
`InvalidOperationException` when it's created ("noda-js/system needs the host's Intl ..."): use the bundled tzdb.

There are no static imports of host modules: FFI and the addon are reached through `process.getBuiltinModule`,
`Deno.dlopen` and feature detection, so `noda-js/system` loads anywhere, and the core and tzdb entry points don't
contain any of it. Node prints an `ExperimentalWarning` the first time `node:ffi` is used.

### On Windows: Windows' zones, as .NET sees them

With FFI or the addon, noda-js reads the same data `TimeZoneInfo` reads on Windows, and converts it the same way:

- `src/noda-js/System/` is a port of the parts of .NET's `System.TimeZoneInfo` NodaTime uses (dotnet/runtime's
  `TimeZoneInfo.cs`, `TimeZoneInfo.AdjustmentRule.cs`, `TimeZoneInfo.TransitionTime.cs` and `TimeZoneInfo.Win32.cs`, MIT
  licensed): the registry's `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Time Zones` keys (`TZI` and the
  `Dynamic DST` years become adjustment rules exactly as .NET makes them, with their validation), the display and
  standard/daylight names (from the `MUI_*` values via the `tzres.dll.mui` of the user's UI language, or its parents,
  else the `Display`/`Std`/`Dlt` values), `TimeZoneInfo.Local` (from `GetDynamicTimeZoneInformation`, including
  "Adjust for daylight saving time automatically" being off), `TimeZoneInfo.Utc`, `GetSystemTimeZones` (sorted by
  base offset, then display name) and `FindSystemTimeZoneById` (case-insensitive, with .NET's cache).
- `SystemDateTimeZone.FromTimeZoneInfo` is a port of `BclDateTimeZone.FromTimeZoneInfo`: the rules become zone
  intervals exactly as NodaTime makes them (including its corrections, such as transitions at 23:59:59.999 being
  midnight).

So `GetIds()`, `GetSystemDefaultId()`, `DisplayName` and every zone interval are the same as NodaTime's
`BclDateTimeZoneSource` gives on .NET on the same machine. `test/system/WindowsComparison.test.ts` checks this against
an export from NodaTime on .NET (`scripts/export-system-zones.ps1`): every zone's names, rules and intervals from 1800
to 2100, the IDs in order, and the local zone.

`ForId` also accepts IANA IDs, as `FindSystemTimeZoneById` does on .NET 6+ on Windows: the zone keeps the IANA ID, with
the rules of the Windows zone it maps to. The mapping is CLDR's windowsZones (the copy `noda-js/windows` bundles); .NET
uses the copy in its ICU, which may be older (the tools' ICU 72 maps e.g. America/Vancouver to "Pacific Standard
Time", the CLDR noda-js bundles to "British Columbia Standard Time"), and .NET also accepts the old POSIX-style IDs (EST5EDT, ...)
that CLDR has dropped.

The Windows calls are behind one small interface (`IWindowsTimeZoneApi`: `GetDynamicTimeZoneInformation`, the registry
reads, the UI languages, the system directory, `LoadString`), with plain JavaScript values (no BigInt, no pointers).
The FFI implementation avoids 64-bit results: registry handles are passed as numbers, and MUI strings are loaded with
`SHLoadIndirectString`. Bun and Deno are supported through the same interface, but only Node is tested.

### Without Windows' data: Intl

`Intl` only reports the UTC offset (and an abbreviation) at a given instant, so a zone's transitions are found by
sampling its offset every week of each year and binary-searching to the millisecond wherever it changes (cached per
year). That's approximate:

- Two transitions less than a week apart that return to the same offset are missed.
- `ZoneInterval.Name` is the host's English abbreviation (`timeZoneName: "short"` in `en-US`, e.g. "AEST" or
  "GMT+5:30"); `DisplayName` is its English generic name ("Australian Eastern Time"), or the ID.
- `Intl` gives only the total offset: within each UTC year, the smallest offset in force is taken as standard time and
  anything up to 2 hours above it as daylight saving time, so `Savings` is a heuristic (wrong for negative DST, such as
  Europe/Dublin's, and for standard offset changes part way through a year).
- Before 1800, the offset is the one at the start of 1800; from 2040, the zone is assumed to follow one annual rule,
  as ICU does. `MinOffset` and `MaxOffset` are estimated from the offsets at the start of each quarter, 1800-2040.
- There's no `OriginalZone` (null).

On Windows (the third row of the table), the IDs are the Windows IDs that CLDR maps (for its "001" territory) to a
zone the host supports, with that zone's rules: `ForId("AUS Eastern Standard Time")` has Australia/Sydney's rules and
keeps the Windows ID. IANA IDs CLDR maps are accepted too (keeping the IANA ID, with their own rules). The host's zone
is the Windows ID CLDR maps it to (or its IANA ID, if it has none). Names and rules come from `Intl`, so they're not
.NET's.

## The system default zone

`GetSystemDefault()` (both providers) and `SystemDateTimeZone.ForSystemDefault()` (NodaTime's "local zone") give the
host's current zone. `SystemDateTimeZoneProvider.GetSystemDefault()` and `SystemDateTimeZone.ForSystemDefault()` always
agree, as they share one function for it.

### The TZ environment variable

Both providers honour `TZ` on every host that has environment variables (read with `process.env.TZ`, or
`Deno.env.get("TZ")` when the env permission has been granted; browsers have none). A leading `:` is ignored, as on
Unix.

- **Not set, or empty**: the host's zone. On Windows with FFI or the addon, that's `TimeZoneInfo.Local` (from
  `GetDynamicTimeZoneInformation`); otherwise `Intl`'s default zone (which already reflects `TZ` on Unix).
- **Set to a zone ID**: that zone, looked up as `ForId` looks it up. On Windows, a Windows ID is used as is (in the
  registry's case: `TZ="sa western standard time"` is "SA Western Standard Time"), and an IANA ID is mapped to its
  Windows ID by CLDR (`TZ=America/La_Paz` is "SA Western Standard Time"), as `FindSystemTimeZoneById` maps it. On
  Windows without FFI, a Windows ID gets its CLDR primary zone's rules from `Intl`, keeping the Windows ID. Elsewhere,
  an IANA ID.
- **Set, but not a zone** (an unknown ID, a POSIX TZ string such as `AEST-10AEDT,M10.1.0,M4.1.0/3`, a Windows ID
  outside Windows): **UTC**, as Node (`Etc/Unknown`, with offset 0), Python, glibc and .NET on Unix do. The system
  provider's UTC is "UTC" on Windows (the registry's, and `TimeZoneInfo.Utc`'s, ID) and "Etc/UTC" elsewhere; the tzdb
  provider's is "Etc/UTC".

The tzdb provider maps a Windows ID in `TZ` through its source's `WindowsMapping` (as NodaTime maps
`TimeZoneInfo.Local`'s Windows IDs), and uses an IANA ID as is.

Under Node on Windows *without* FFI, Node's `Intl` and `Date` honour `TZ` (IANA IDs only), and JavaScript can't see
the Windows setting behind it. .NET on Windows ignores `TZ`, so there `GetSystemDefault()` can differ from .NET's when
`TZ` is set; with FFI or the addon it's honoured explicitly, the same way.

### When the zone can't be determined

The tzdb provider maps the host's zone as NodaTime's `TzdbDateTimeZoneSource.MapTimeZoneInfoId` maps
`TimeZoneInfo.Local`: a Windows ID through the primary Windows mapping, a tzdb ID as is, and otherwise
`GuessZoneIdByTransitions` (ported): the zone whose offsets match the host's at 70% or more of the transitions of every
tzdb zone over the next five years. The host's offsets come from `Date` (`getTimezoneOffset`), so this works on hosts
without `Intl` too (e.g. QuickJS), where the zone has no ID ("Local"). Ties go to the first zone in ordinal order of ID
(NodaTime orders by the current culture). A zone named by `TZ` isn't guessed: if it doesn't map, it's UTC (above).

Only when there's nothing to go on (no `TZ`, no host zone, and no guess) is there no system default:
`GetSystemDefaultId()` returns null and `GetSystemDefault()` throws `DateTimeZoneNotFoundException`, as NodaTime's
`DateTimeZoneCache` does. (`SystemDateTimeZone.ForSystemDefault()` throws `InvalidOperationException` when the system
reports no zone, as `BclDateTimeZone.ForSystemDefault` does.)

## Windows time zone IDs elsewhere (`noda-js/windows`)

Data written by .NET apps using `BclDateTimeZone` on Windows has Windows zone IDs ("2024-04-01T01:30:00+11 AUS Eastern
Standard Time"). On any host, `WindowsIdDateTimeZoneProvider` wraps a provider so it also accepts them, mapping each to
its CLDR primary tzdb zone (the zone keeps its tzdb ID); `GetCldrWindowsZones()` is the mapping itself. That's tzdb's
rules for the mapped zone, not Windows': use `noda-js/system` on Windows for those.

## Native addon (optional)

On Windows, `noda-js/system` reads Windows' time zone data through a small native addon when it's installed, and
through the runtime's FFI otherwise. The addon is published as two packages, one per Windows architecture:

| Package | Platform |
|---|---|
| `noda-js-win32-x64` | 64-bit Windows (`"os": ["win32"], "cpu": ["x64"]`) |
| `noda-js-win32-arm64` | Windows on ARM64 (`"os": ["win32"], "cpu": ["arm64"]`) |

`noda-js` lists both as `optionalDependencies`, so npm (and pnpm, Yarn) install the one matching the machine and skip
the other; on Linux, macOS and in browser projects nothing extra is installed. There's no 32-bit package: Node.js has
no official 32-bit Windows builds since Node 23, and Node 22 (the last line with them) ends support in April 2027. On
32-bit Node, `noda-js/system` uses FFI if available, otherwise `Intl`.

What the addon changes:

- **Nothing in the results.** It makes the same Windows calls as the FFI implementation (`IWindowsTimeZoneApi`), so IDs,
  names and zone intervals are the same, and match .NET's `TimeZoneInfo`. Each build is checked against the FFI
  implementation for every operation and every time zone in the registry (`native/windows/compare.ts`), and the tests
  run real processes with each combination (`test/system/environment.test.ts`).
- **No experimental FFI.** Node's `node:ffi` is experimental: it prints an `ExperimentalWarning` on first use, is
  missing in older Node versions, and is blocked by Node's permission model unless `--allow-ffi` is passed. The addon is a
  plain Node-API module: it works on any Node version with Node-API 8 (Node 12.22+), with no warning, and with Bun and
  Deno, which load Node-API modules.

The order on Windows is: the addon, if its package is installed and loads; then FFI (`node:ffi`, `bun:ffi` or Deno's
`Deno.dlopen`); then `Intl`. `SystemDateTimeZoneSource.VersionId` says which: e.g. "TimeZoneInfo: Windows
(noda-js-win32-x64)" or "TimeZoneInfo: Windows (node:ffi)".

To do without the addon, install with `npm install --omit=optional` (or remove the package): `noda-js/system` then uses
FFI, or `Intl`. Bundlers don't include it: it's loaded by package name at run time (through
`module.createRequire`), only on Windows under Node, Bun or Deno.

The addon's source is `native/windows/time-zones.c` (C, Node-API, no dependencies beyond Windows). To build it:
`npm run build:native` (`scripts/build-native.ps1`), which needs Visual Studio's C++ build tools (and their ARM64 tools
for an ARM64 build). The build is reproducible (no timestamps, debug information or paths in the binary), so the
release workflow can rebuild and compare it.

## Differences from NodaTime

- `BclDateTimeZoneSource`, `BclDateTimeZone` and `DateTimeZoneProviders.Bcl` are `SystemDateTimeZoneSource`,
  `SystemDateTimeZone` and `SystemDateTimeZoneProvider` (`noda-js/system`). `TimeZoneInfo` is noda-js's port: its public
  members are `Id`, `DisplayName`, `StandardName`, `DaylightName`, `SupportsDaylightSavingTime` and `HasIanaId` (the
  rest, which use .NET's `DateTime` and `TimeSpan`, are internal). Only Windows' data is read (.NET's Unix rules,
  `FromUnixAdjustmentRule` and `FixUnixTransitions`, aren't ported); elsewhere zones come from `Intl` and have no
  `OriginalZone`.
- `SystemDateTimeZoneSource.VersionId` describes the backend (above), not `TimeZoneInfo`'s assembly version.
- The system provider honours `TZ` on Windows too (.NET on Windows ignores it), accepting Windows IDs there; an unknown
  `TZ` is UTC.
- The tzdb provider's system zone is `TZ`'s, or the host's `Intl` zone with `Date`'s offsets, rather than
  `TimeZoneInfo.Local`; `MapTimeZoneInfoId` takes those (an ID and offsets) rather than a `TimeZoneInfo`.
- No `DateTimeZoneProviders`: import a provider. No `ClockExtensions.InTzdbSystemDefaultZone` /
  `InBclSystemDefaultZone`: use `InZone(clock, tzdb.GetSystemDefault())`.
