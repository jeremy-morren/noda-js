using System.CommandLine;
using NodaJs.Tools.Cldr;
using NodaJs.Tools.Common;
using NodaJs.Tools.Data;
using NodaJs.Tools.Scenarios;
using NodaJs.Tools.SystemZones;

// Generates noda-js's *.generated.ts files from .NET and NodaTime. tools/generate.ps1 builds and runs this.
//
//   NodaJs.Tools data [parts...] [--tzdb compile|latest|embedded] [--tzdata <url|path>] [--cldr <tag|path>]
//   NodaJs.Tools cldr [--cldr <tag|path>]
//   NodaJs.Tools scenarios
//   NodaJs.Tools all [--tzdb ...] [--tzdata ...] [--cldr ...]
//
// Every command takes --repo <path> (default: found from the working directory).

var repoOption = new Option<string?>("--repo")
{
    Description = "The noda-js repository root (default: found from the working directory).",
    Recursive = true,
};
var tzdbOption = new Option<string>("--tzdb")
{
    Description = "Where the bundled tzdb comes from: compile it with NodaTime's TzdbCompiler (latest IANA release + " +
                  "latest CLDR windowsZones.xml), nodatime.org's latest NZD, or the NZD embedded in the pinned NodaTime.",
    DefaultValueFactory = _ => "compile",
};
tzdbOption.AcceptOnlyFromAmong("compile", "latest", "embedded");
var tzdataOption = new Option<string?>("--tzdata")
{
    Description = "IANA tzdata tarball (URL or path) to compile, for --tzdb compile (default: the latest IANA release).",
};
var cldrOption = new Option<string?>("--cldr")
{
    Description = "CLDR release tag (e.g. release-49) or path to a windowsZones.xml (default: the latest CLDR release).",
};
var partsArgument = new Argument<string[]>("parts")
{
    Description = $"The parts to export (default: all of them): {string.Join(", ", DataCommand.Parts)}.",
    Arity = ArgumentArity.ZeroOrMore,
};
partsArgument.AcceptOnlyFromAmong(DataCommand.Parts);

var data = new Command("data", "Enums, constants, error messages, cultures, the bundled tzdb, the API listing and golden vectors.")
{
    partsArgument, tzdbOption, tzdataOption, cldrOption,
};
data.SetAction((result, _) => Run(result, output =>
    DataCommand.Run(output, result.GetValue(partsArgument)!, result.GetValue(tzdbOption)!, result.GetValue(tzdataOption), result.GetValue(cldrOption))));

var cldr = new Command("cldr", "CLDR's Windows ↔ tzdb zone ID mapping.") { cldrOption };
cldr.SetAction((result, _) => Run(result, output => CldrExport.Run(output, result.GetValue(cldrOption))));

var scenarios = new Command("scenarios", "Every NUnit test case in NodaTime.Test and NodaTime.TzdbCompiler.Test, as test/scenarios.");
scenarios.SetAction((result, _) => Run(result, output =>
{
    new Extractor(output).Run();
    return Task.CompletedTask;
}));

var all = new Command("all", "data, cldr and scenarios.") { tzdbOption, tzdataOption, cldrOption };
all.SetAction((result, _) => Run(result, async output =>
{
    await DataCommand.Run(output, [], result.GetValue(tzdbOption)!, result.GetValue(tzdataOption), result.GetValue(cldrOption));
    await CldrExport.Run(output, result.GetValue(cldrOption));
    new Extractor(output).Run();
}));

var outputOption = new Option<string>("--output")
{
    Description = "Where to write the JSON (default: test-results/system-zones.json in the repo).",
};
var systemZones = new Command("system-zones",
    "NodaTime's BclDateTimeZoneSource on this machine (IDs, names, rules and zone intervals) as JSON, for test/system/.")
{
    outputOption,
};
systemZones.SetAction(result =>
{
    if (result.GetValue(repoOption) is { } repo)
        ToolEnvironment.UseRepoRoot(repo);
    SystemZonesExport.Run(result.GetValue(outputOption) ?? Path.Combine(ToolEnvironment.RepoRoot, "test-results", "system-zones.json"));
    return 0;
});

var root = new RootCommand("Generates noda-js's *.generated.ts files from .NET and NodaTime.") { repoOption, data, cldr, scenarios, all, systemZones };
return await root.Parse(args).InvokeAsync();

// Shared by every command: the repo root, the pinned ICU check, then the command's exports.
async Task<int> Run(ParseResult result, Func<GeneratedFiles, Task> export)
{
    if (result.GetValue(repoOption) is { } repo)
        ToolEnvironment.UseRepoRoot(repo);
    ToolEnvironment.RequireIcu();
    Console.WriteLine($"NodaJs.Tools {result.CommandResult.Command.Name}: {ToolEnvironment.Describe()}; repo {ToolEnvironment.RepoRoot}");
    var output = new GeneratedFiles("NodaJs.Tools");
    await export(output);
    output.Summarize();
    return 0;
}
