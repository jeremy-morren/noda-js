using System.Reflection;
using System.Xml.Linq;
using NodaJs.Tools.Common;
using NodaTime.TimeZones.Cldr;

namespace NodaJs.Tools.Cldr;

/// <summary>
/// The <c>cldr</c> command: the Windows (BCL) time zone ID mapping as TypeScript, from CLDR's windowsZones.xml
/// (Windows ID ↔ IANA/tzdb ID), parsed by NodaTime's own CldrWindowsZonesParser →
/// src/noda-js/Bcl/CldrWindowsZones.generated.ts. noda-js uses it to accept Windows zone IDs (e.g. in deserialized
/// data) and map them to tzdb zones, and noda-js/system to map IANA IDs to Windows IDs. Windows' own zone <em>rules</em>
/// are deliberately not exported: they exist only in a Windows machine's registry, with no published, redistributable
/// source (noda-js/system reads them from the machine it runs on).
/// </summary>
internal static class CldrExport
{
    public static async Task Run(GeneratedFiles output, string? source)
    {
        var (document, origin) = await Downloads.CldrWindowsZones(source);
        // NodaTime's parser (internal, in NodaTime.TzdbCompiler: see NodaTimeInternals), so we read the file exactly as
        // NodaTime does.
        var zones = NodaTimeInternals.ParseCldrWindowsZones(null, document);

        var body = new TypescriptWriter()
            .WriteLine("import type { WindowsZonesData } from \"./CldrWindowsZones.ts\";", emptyLineAfter: true)
            .DocComment("CLDR's mapping between Windows time zone IDs and IANA (tzdb) IDs.")
            .OpenBlock("export const cldrWindowsZones: WindowsZonesData = {")
            .Property(nameof(zones.Version), Ts.Str(zones.Version))
            .Property(nameof(zones.TzdbVersion), Ts.Str(zones.TzdbVersion))
            .Property(nameof(zones.WindowsVersion), Ts.Str(zones.WindowsVersion))
            .OpenBlock($"{nameof(zones.MapZones)}: [");
        foreach (var mapZone in zones.MapZones)
            body.WriteLine("{ " +
                           $"{nameof(mapZone.WindowsId)}: {Ts.Str(mapZone.WindowsId)}, " +
                           $"{nameof(mapZone.Territory)}: {Ts.Str(mapZone.Territory)}, " +
                           $"{nameof(mapZone.TzdbIds)}: [{string.Join(", ", mapZone.TzdbIds.Select(Ts.Str))}] " +
                           "},");
        body.CloseBlock("],")
            .CloseBlock("};");
        output.Write("src/noda-js/Bcl/CldrWindowsZones.generated.ts", 
            "cldr", 
            body,
            [$"Source: {origin}", "CLDR data is under the Unicode License (see NOTICE.txt)."]);
    }
}
