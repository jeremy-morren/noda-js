// noda-js: a check run by scripts/build-native.ps1 after building the addon: every IWindowsTimeZoneApi operation must
// return exactly what the node:ffi implementation returns, for every time zone in the registry (when node:ffi is
// available). Usage: node native/windows/compare.ts <path to time-zones.node>

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { FfiWindowsTimeZoneApi } from "../../src/noda-js/dist/System/Windows/FfiWindowsTimeZoneApi.js";

type Api = Record<string, (...args: unknown[]) => unknown>;

const addonPath = process.argv[2];
if (addonPath === undefined) {
  throw new Error("Usage: node native/windows/compare.ts <path to time-zones.node>");
}
const addon = createRequire(import.meta.url)(resolve(addonPath)) as Api;
const ffi = (FfiWindowsTimeZoneApi as unknown as { TryCreate(): Api | null }).TryCreate();
if (ffi === null) {
  console.log("node:ffi isn't available: skipping the comparison with it.");
  process.exit(0);
}

let checks = 0;
const failures: string[] = [];

/** Calls the operation on both implementations and records a difference. */
function Compare(operation: string, ...args: unknown[]): unknown {
  const fromAddon = addon[operation]!(...args);
  const fromFfi = ffi![operation]!(...args);
  checks++;
  if (!isDeepStrictEqual(Normalize(fromAddon), Normalize(fromFfi))) {
    failures.push(`${operation}(${args.map(a => JSON.stringify(a)).join(", ")}): addon ${JSON.stringify(Normalize(fromAddon))}, ffi ${JSON.stringify(Normalize(fromFfi))}`);
  }
  return fromAddon;
}

/** Uint8Arrays compare by content, whatever their buffer. */
function Normalize(value: unknown): unknown {
  return value instanceof Uint8Array ? Array.from(value) : value;
}

const timeZones = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Time Zones";
Compare("GetDynamicTimeZoneInformation");
Compare("GetSystemDirectory");
Compare("GetUserPreferredUILanguages");
Compare("RegistryKeyExists", timeZones);
Compare("RegistryKeyExists", `${timeZones}\\No Such Zone`);
Compare("GetRegistrySubKeyNames", `${timeZones}\\No Such Zone`);
Compare("GetRegistryValue", timeZones, "No such value");
const systemDirectory = addon["GetSystemDirectory"]!() as string;
Compare("FileExists", `${systemDirectory}\\tzres.dll`);
Compare("FileExists", systemDirectory);
Compare("FileExists", `${systemDirectory}\\no-such-file.dll`);

const ids = Compare("GetRegistrySubKeyNames", timeZones) as string[];
for (const id of ids) {
  const key = `${timeZones}\\${id}`;
  for (const name of ["Display", "Std", "Dlt", "MUI_Display", "MUI_Std", "MUI_Dlt", "TZI"]) {
    const value = Compare("GetRegistryValue", key, name);
    // The MUI names are "@tzres.dll,-<id>": load each string through both.
    if (typeof value === "string" && value.startsWith("@")) {
      const match = /^@(.*),-(\d+)$/.exec(value);
      if (match !== null) {
        Compare("LoadString", `${systemDirectory}\\${match[1]}`, Number(match[2]));
      }
    }
  }
  const dynamic = `${key}\\Dynamic DST`;
  if (Compare("RegistryKeyExists", dynamic) === true) {
    Compare("GetRegistrySubKeyNames", dynamic);
    const first = Compare("GetRegistryValue", dynamic, "FirstEntry");
    const last = Compare("GetRegistryValue", dynamic, "LastEntry");
    if (typeof first === "number" && typeof last === "number") {
      for (let year = first; year <= last; year++) {
        Compare("GetRegistryValue", dynamic, String(year));
      }
    }
  }
}
Compare("LoadString", `${systemDirectory}\\no-such-file.dll`, 1);

console.log(`${checks} checks over ${ids.length} time zones; ${failures.length} differences.`);
for (const failure of failures.slice(0, 20)) {
  console.log(failure);
}
process.exit(failures.length === 0 ? 0 : 1);
