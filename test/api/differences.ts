// Deliberate differences between NodaTime's public API and noda-js, used by api.test.ts.
// Keep in sync with docs/api-differences.md.

/** Types ("Type") and members ("Type.CSharpMember") that aren't ported, with the reason. */
export const notPorted: Readonly<Record<string, string>> = {
  // Not ported (docs/api-differences.md)
  DateTimeZoneProviders: "no global provider registry; import noda-js/tzdb/bundled or noda-js/system",
  DateTimeExtensions: "BCL interop",
  DateTimeOffsetExtensions: "BCL interop",
  DateOnlyExtensions: "BCL interop",
  TimeOnlyExtensions: "BCL interop",
  TimeSpanExtensions: "BCL interop",
  StopwatchExtensions: "BCL interop",
  TimeProviderExtensions: "BCL interop",
  DayOfWeekExtensions: "BCL interop (System.DayOfWeek)",
  BclConversions: "BCL interop",
  TypeConverterSettings: ".NET TypeConverters",
  "CalendarSystem.Badi": "exported by noda-js/calendars/badi instead (tree shaking)",
  "CalendarSystem.HebrewCivil": "exported by noda-js/calendars/hebrew instead (tree shaking)",
  "CalendarSystem.HebrewScriptural": "exported by noda-js/calendars/hebrew instead (tree shaking)",
  "CalendarSystem.IslamicBcl": "exported by noda-js/calendars/islamic instead (tree shaking)",
  "CalendarSystem.PersianSimple": "exported by noda-js/calendars/persian instead (tree shaking)",
  "CalendarSystem.PersianArithmetic": "exported by noda-js/calendars/persian instead (tree shaking)",
  "CalendarSystem.PersianAstronomical": "exported by noda-js/calendars/persian instead (tree shaking)",
  "CalendarSystem.UmAlQura": "exported by noda-js/calendars/umalqura instead (tree shaking)",
  "CalendarSystem.GetHebrewCalendar": "exported by noda-js/calendars/hebrew instead (tree shaking)",
  "CalendarSystem.GetIslamicCalendar": "exported by noda-js/calendars/islamic instead (tree shaking)",
  "LocalDatePattern.CreateWithCurrentCulture": "no current culture in JS",
  "LocalTimePattern.CreateWithCurrentCulture": "no current culture in JS",
  "LocalDateTimePattern.CreateWithCurrentCulture": "no current culture in JS",
  "InstantPattern.CreateWithCurrentCulture": "no current culture in JS",
  "DurationPattern.CreateWithCurrentCulture": "no current culture in JS",
  "OffsetPattern.CreateWithCurrentCulture": "no current culture in JS",
  "OffsetDatePattern.CreateWithCurrentCulture": "no current culture in JS",
  "OffsetTimePattern.CreateWithCurrentCulture": "no current culture in JS",
  "OffsetDateTimePattern.CreateWithCurrentCulture": "no current culture in JS",
  "YearMonthPattern.CreateWithCurrentCulture": "no current culture in JS",
  "AnnualDatePattern.CreateWithCurrentCulture": "no current culture in JS",
  "ZonedDateTimePattern.CreateWithCurrentCulture": "no current culture in JS",
  "NodaFormatInfo.CurrentInfo": "no current culture in JS",
  "TzdbDateTimeZoneSource.Default": "no data in the class; use tzdbSource from noda-js/tzdb/bundled",
  "TzdbDateTimeZoneSource.FromStream": "no streams; use TzdbDateTimeZoneSource.FromBytes / FromBase64",
  "ClockExtensions.InTzdbSystemDefaultZone": "core can't depend on tzdb; use InZone(clock, tzdb.GetSystemDefault())",
  "ClockExtensions.InBclSystemDefaultZone": "BCL interop",
  // No BigInt (noda-js targets ES2015); ToInt64Nanoseconds and FromNanoseconds with a decimal string are exact within
  // the long range. (The FromNanoseconds(BigInteger) and FromNanoseconds(Int128) overloads aren't ported either.)
  "Duration.ToBigIntegerNanoseconds": "no BigInt in ES2015; use ToInt64Nanoseconds (exact as a C# long) or TotalNanoseconds",
  "Duration.ToInt128Nanoseconds": "no BigInt in ES2015; use ToInt64Nanoseconds (exact as a C# long) or TotalNanoseconds",
  // Abstract in C#: the TS abstract members are compile-time only; the implementations are checked through
  // the instances NodaTime exposes (OffsetDateTime.Comparer.Local etc.) by tsc.
  "OffsetDateTimeComparer.Compare": "abstract (implemented by Comparer.local / Comparer.instant)",
  "OffsetDateTimeComparer.Equals": "abstract (implemented by Comparer.local / Comparer.instant)",
  "ZonedDateTimeComparer.Compare": "abstract (implemented by Comparer.local / Comparer.instant)",
  "ZonedDateTimeComparer.Equals": "abstract (implemented by Comparer.local / Comparer.instant)",
  "DateTimeZone.GetZoneInterval": "abstract (implemented by every zone class)",
};

/** Types exported under another name (NodaTime's name → noda-js's), with all their members (BCL interop included). */
export const renamedTypes: Readonly<Record<string, string>> = {
  BclDateTimeZone: "SystemDateTimeZone",
  BclDateTimeZoneSource: "SystemDateTimeZoneSource",
};

/** Members whose noda-js name isn't the mechanical camelCase of the C# name ("Type.CSharpMember" → name). */
export const renamed: Readonly<Record<string, string>> = {};
