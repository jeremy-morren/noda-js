using System.Globalization;
using System.Text.Json;
using NodaJs.Tools.Common;
using NodaTime;
using NodaTime.TimeZones;

namespace NodaJs.Tools.SystemZones;

/// <summary>
/// The <c>system-zones</c> command: what NodaTime's BclDateTimeZoneSource (DateTimeZoneProviders.Bcl) sees on this
/// machine, as JSON, so test/system/ can compare noda-js's system source (noda-js/system) with it exactly. On Windows
/// that's the registry's time zones, as .NET's TimeZoneInfo reads them. Written by scripts/export-system-zones.ps1 to
/// test-results/system-zones.json (it's machine-specific, so it isn't committed).
/// </summary>
/// <remarks>
/// For each zone: TimeZoneInfo's names, base offset and adjustment rules (so a difference can be traced to the rules or
/// to the conversion), and BclDateTimeZone's zone intervals over [<see cref="StartYear"/>, <see cref="EndYear"/>).
/// Instants are milliseconds since the Unix epoch (Windows' data has millisecond precision; the export checks there's
/// nothing finer), null for the start or end of time.
/// </remarks>
internal static class SystemZonesExport
{
    public const int StartYear = 1800;
    public const int EndYear = 2100;

    public static void Run(string outputPath)
    {
        var source = new BclDateTimeZoneSource();
        var ids = source.GetIds().ToList();
        var start = Instant.FromUtc(StartYear, 1, 1, 0, 0);
        var end = Instant.FromUtc(EndYear, 1, 1, 0, 0);

        var zones = new List<object>();
        foreach (var id in ids)
        {
            var zone = source.ForId(id);
            zones.Add(DescribeZone(zone, start, end));
        }

        // .NET 6+ also accepts IANA IDs on Windows (converted with ICU's copy of CLDR's windowsZones).
        var ianaToWindows = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var ianaId in TzdbDateTimeZoneSource.Default.GetIds())
        {
            if (TimeZoneInfo.TryConvertIanaIdToWindowsId(ianaId, out var windowsId))
                ianaToWindows[ianaId] = windowsId;
        }

        var local = BclDateTimeZone.ForSystemDefault();
        var document = new
        {
            generator = $"tools/NodaJs.Tools (system-zones) from {ToolEnvironment.Describe()}",
            os = System.Runtime.InteropServices.RuntimeInformation.OSDescription,
            uiCulture = CultureInfo.CurrentUICulture.Name,
            startYear = StartYear,
            endYear = EndYear,
            versionId = source.VersionId,
            systemDefaultId = source.GetSystemDefaultId(),
            local = DescribeZone(local, start, end),
            ids,
            zones,
            ianaToWindows,
        };
        var json = JsonSerializer.Serialize(document, new JsonSerializerOptions { WriteIndented = true });
        var fullPath = Path.GetFullPath(outputPath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllText(fullPath, json + "\n");
        Console.WriteLine($"Wrote {ids.Count} zones ({StartYear}-{EndYear}) to {fullPath}");
    }

    private static object DescribeZone(BclDateTimeZone zone, Instant start, Instant end)
    {
        var info = zone.OriginalZone;
        return new
        {
            id = zone.Id,
            displayName = zone.DisplayName,
            standardName = info.StandardName,
            daylightName = info.DaylightName,
            baseUtcOffsetMinutes = (int) info.BaseUtcOffset.TotalMinutes,
            supportsDaylightSavingTime = info.SupportsDaylightSavingTime,
            minOffsetSeconds = zone.MinOffset.Seconds,
            maxOffsetSeconds = zone.MaxOffset.Seconds,
            rules = info.GetAdjustmentRules().Select(DescribeRule).ToList(),
            // [start, end, wall offset (seconds), savings (seconds), name]
            intervals = zone.GetZoneIntervals(start, end).Select(DescribeInterval).ToList(),
        };
    }

    private static object DescribeRule(TimeZoneInfo.AdjustmentRule rule) => new
    {
        dateStart = rule.DateStart.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff", CultureInfo.InvariantCulture),
        dateEnd = rule.DateEnd.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff", CultureInfo.InvariantCulture),
        daylightDeltaMinutes = (int) rule.DaylightDelta.TotalMinutes,
        baseUtcOffsetDeltaMinutes = (int) rule.BaseUtcOffsetDelta.TotalMinutes,
        start = DescribeTransition(rule.DaylightTransitionStart),
        end = DescribeTransition(rule.DaylightTransitionEnd),
    };

    // [fixed (1) or floating (0), month, week, day, day of week, time of day (milliseconds)]
    private static int[] DescribeTransition(TimeZoneInfo.TransitionTime transition) =>
    [
        transition.IsFixedDateRule ? 1 : 0,
        transition.Month,
        transition.Week,
        transition.Day,
        (int) transition.DayOfWeek,
        (int) transition.TimeOfDay.TimeOfDay.TotalMilliseconds,
    ];

    private static object?[] DescribeInterval(ZoneInterval interval) =>
    [
        interval.HasStart ? Milliseconds(interval.Start) : null,
        interval.HasEnd ? Milliseconds(interval.End) : null,
        interval.WallOffset.Seconds,
        interval.Savings.Seconds,
        interval.Name,
    ];

    private static long Milliseconds(Instant instant)
    {
        var milliseconds = instant.ToUnixTimeMilliseconds();
        if (Instant.FromUnixTimeMilliseconds(milliseconds) != instant)
            throw new InvalidOperationException($"{instant} has sub-millisecond precision");
        return milliseconds;
    }
}
