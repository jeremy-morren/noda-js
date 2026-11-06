// The system default zone in real processes: Node started with the TZ environment variable set to a Windows ID, an
// IANA ID, an unknown ID, or not set (and, on Windows, with node:ffi turned off by --no-experimental-ffi). Each process
// runs a probe (bundled from the sources with esbuild) that reports noda-js/system's backend and system default, its
// provider's GetSystemDefault, SystemDateTimeZone.ForSystemDefault, and the tzdb provider's GetSystemDefault.
//
// On Windows, the same probe also runs with each backend, by what the process really has: the native addon package
// (noda-js-win32-<arch>, built by scripts/build-native.ps1) installed next to the probe or not, and node:ffi on or off
// (--no-experimental-ffi). The addon and node:ffi read the same Windows data, so they must give identical results.
//
// Each process takes a second or so (more on a busy CI runner), hence the long timeouts.
//
// Node only (child processes, esbuild); vitest.config.ts's nodeOnly list is for whole files, so the suite skips itself
// elsewhere and loads its Node-only modules dynamically.

import { beforeAll, describe, expect, it } from "vitest";

declare const process: { platform: string; arch: string; execPath: string; env: Record<string, string | undefined> } | undefined;

const isNode = typeof window === "undefined" && typeof process !== "undefined";
const isWindows = isNode && process!.platform === "win32";

// Module specifiers in variables, so that Vite doesn't try to resolve them for the browser projects.
const esbuildModule = "esbuild";
const fsModule = "node:fs";
const pathModule = "node:path";
const osModule = "node:os";
const childProcessModule = "node:child_process";
const urlModule = "node:url";

const probeSource = `
import { SystemDateTimeZone, SystemDateTimeZoneProvider, SystemDateTimeZoneSource } from "./src/noda-js/entries/system.ts";
import { tzdb } from "./src/noda-js/entries/tzdb-bundled.ts";
import { Instant } from "./src/noda-js/index.ts";

const january = Instant.FromUtc(2026, 1, 15, 12, 0);
// Windows zones with a varied history, for comparing backends: offsets at a few instants, by ID.
const sampleIds = ["AUS Eastern Standard Time", "Pacific Standard Time", "GMT Standard Time", "Tokyo Standard Time",
  "SA Western Standard Time", "E. South America Standard Time", "Samoa Standard Time", "Morocco Standard Time"];
const sampleInstants = [Instant.FromUtc(1980, 1, 1, 0, 0), Instant.FromUtc(2010, 7, 1, 0, 0), Instant.FromUtc(2026, 1, 15, 12, 0), Instant.FromUtc(2026, 7, 15, 12, 0)];
const july = Instant.FromUtc(2026, 7, 15, 12, 0);
function describe(get) {
  try {
    const zone = get();
    return { id: zone.Id, january: zone.GetUtcOffset(january).Seconds, july: zone.GetUtcOffset(july).Seconds };
  } catch (e) {
    return { error: e.name };
  }
}
const source = new SystemDateTimeZoneSource();
const result = {
  backend: source.Backend,
  versionId: source.VersionId,
  systemDefaultId: source.GetSystemDefaultId(),
  ids: source.GetIds().length,
  hasWindowsIds: source.GetIds().indexOf("AUS Eastern Standard Time") !== -1,
  idList: source.GetIds().join("|"),
  samples: source.GetIds().indexOf("AUS Eastern Standard Time") === -1 ? null : sampleIds.map(id => {
    try {
      const zone = source.ForId(id);
      return [id, zone.Name ?? null, sampleInstants.map(instant => zone.GetUtcOffset(instant).Seconds)];
    } catch (e) {
      return [id, e.name];
    }
  }),
  provider: describe(() => SystemDateTimeZoneProvider.GetSystemDefault()),
  forSystemDefault: describe(() => SystemDateTimeZone.ForSystemDefault()),
  tzdb: describe(() => tzdb.GetSystemDefault()),
};
process.stdout.write(JSON.stringify(result));
`;

interface Zone {
  readonly id?: string;
  readonly january?: number;
  readonly july?: number;
  readonly error?: string;
}

interface Probe {
  readonly backend: "addon" | "ffi" | "intl";
  readonly versionId: string;
  readonly systemDefaultId: string | null;
  readonly ids: number;
  readonly hasWindowsIds: boolean;
  readonly idList: string;
  readonly samples: unknown;
  readonly provider: Zone;
  readonly forSystemDefault: Zone;
  readonly tzdb: Zone;
}

let run: (tz: string | undefined, nodeArgs?: string[], withAddon?: boolean) => Probe;
/** Whether the native addon for this architecture is built (src/noda-js-win32-<arch>/time-zones.node). */
let addonBuilt = false;

beforeAll(async () => {
  if (!isNode) {
    return;
  }
  const esbuild = (await import(/* @vite-ignore */ esbuildModule)) as typeof import("esbuild");
  const { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } = (await import(/* @vite-ignore */ fsModule)) as typeof import("node:fs");
  const { join } = (await import(/* @vite-ignore */ pathModule)) as typeof import("node:path");
  const { tmpdir } = (await import(/* @vite-ignore */ osModule)) as typeof import("node:os");
  const { spawnSync } = (await import(/* @vite-ignore */ childProcessModule)) as typeof import("node:child_process");
  const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as typeof import("node:url");

  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = await esbuild.build({
    stdin: { contents: probeSource, resolveDir: root, loader: "ts", sourcefile: "probe.ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const probe = join(mkdtempSync(join(tmpdir(), "noda-js-system-")), "probe.mjs");
  writeFileSync(probe, result.outputFiles[0]!.text);

  // The same probe, with the native addon package installed next to it (as npm installs noda-js's optional
  // dependency): the addon is resolved by package name, relative to the module that loads it.
  const addonPackage = `noda-js-win32-${process!.arch}`;
  const addonSource = join(root, "src", addonPackage);
  addonBuilt = isWindows && existsSync(join(addonSource, "time-zones.node"));
  const probeWithAddon = join(mkdtempSync(join(tmpdir(), "noda-js-system-addon-")), "probe.mjs");
  writeFileSync(probeWithAddon, result.outputFiles[0]!.text);
  if (addonBuilt) {
    const installed = join(probeWithAddon, "..", "node_modules", addonPackage);
    mkdirSync(installed, { recursive: true });
    for (const file of ["package.json", "time-zones.node"]) {
      copyFileSync(join(addonSource, file), join(installed, file));
    }
  }

  run = (tz, nodeArgs = [], withAddon = false) => {
    const env: Record<string, string | undefined> = { ...process!.env };
    delete env["TZ"];
    if (tz !== undefined) {
      env["TZ"] = tz;
    }
    const child = spawnSync(process!.execPath, [...nodeArgs, withAddon ? probeWithAddon : probe], { env, encoding: "utf8" });
    if (child.status !== 0) {
      throw new Error(`The probe failed (TZ=${tz}): ${child.stderr}`);
    }
    return JSON.parse(child.stdout) as Probe;
  };
}, 60_000);

/** Both providers and ForSystemDefault agree on the zone (the tzdb one by its offsets: its IDs are IANA IDs). */
function ExpectAgreement(probe: Probe): void {
  expect(probe.provider.id).toBe(probe.systemDefaultId);
  expect(probe.forSystemDefault.id).toBe(probe.systemDefaultId);
}

describe.runIf(isNode)("the system default zone in a process, by TZ environment variable", { timeout: 120_000 }, () => {
  it("TZ not set: the host's zone", () => {
    const probe = run(undefined);
    expect(probe.backend).toBe(isWindows ? "ffi" : "intl");
    expect(probe.systemDefaultId).not.toBeNull();
    ExpectAgreement(probe);
    expect(probe.tzdb.error).toBeUndefined();
    // The host's zone, by tzdb and by the system: they agree now (if not always on history).
    expect(probe.tzdb.january).toBe(probe.provider.january);
    expect(probe.tzdb.july).toBe(probe.provider.july);
  });

  it("TZ=America/La_Paz", () => {
    const probe = run("America/La_Paz");
    expect(probe.systemDefaultId).toBe(isWindows ? "SA Western Standard Time" : "America/La_Paz");
    ExpectAgreement(probe);
    expect(probe.provider).toMatchObject({ january: -4 * 3600, july: -4 * 3600 });
    expect(probe.tzdb).toEqual({ id: "America/La_Paz", january: -4 * 3600, july: -4 * 3600 });
  });

  it("TZ=Asia/Tokyo", () => {
    const probe = run("Asia/Tokyo");
    expect(probe.systemDefaultId).toBe(isWindows ? "Tokyo Standard Time" : "Asia/Tokyo");
    ExpectAgreement(probe);
    expect(probe.forSystemDefault).toMatchObject({ january: 9 * 3600, july: 9 * 3600 });
    expect(probe.tzdb).toEqual({ id: "Asia/Tokyo", january: 9 * 3600, july: 9 * 3600 });
  });

  it("TZ=:Asia/Tokyo (a leading ':' is ignored)", () => {
    expect(run(":Asia/Tokyo").tzdb.id).toBe("Asia/Tokyo");
  });

  it("TZ=SA Western Standard Time: a Windows ID (on Windows; the tzdb provider maps it everywhere; elsewhere the system provider doesn't know it, so it's UTC)", () => {
    const probe = run("SA Western Standard Time");
    expect(probe.tzdb).toEqual({ id: "America/La_Paz", january: -4 * 3600, july: -4 * 3600 });
    if (isWindows) {
      expect(probe.systemDefaultId).toBe("SA Western Standard Time");
      ExpectAgreement(probe);
      expect(probe.provider).toMatchObject({ january: -4 * 3600, july: -4 * 3600 });
    } else {
      // Not a zone elsewhere (IANA IDs only): UTC.
      expect(probe.systemDefaultId).toBe("Etc/UTC");
      ExpectAgreement(probe);
    }
  });

  it("TZ=an unknown ID: UTC, as for Node, Python, glibc and .NET on Unix", () => {
    for (const tz of ["Mars/Olympus_Mons", "AEST-10AEDT,M10.1.0,M4.1.0/3"]) {
      const probe = run(tz);
      expect(probe.systemDefaultId).toBe(isWindows ? "UTC" : "Etc/UTC");
      ExpectAgreement(probe);
      expect(probe.provider).toMatchObject({ january: 0, july: 0 });
      expect(probe.forSystemDefault).toMatchObject({ january: 0, july: 0 });
      expect(probe.tzdb).toEqual({ id: "Etc/UTC", january: 0, july: 0 });
    }
  });
});

describe.runIf(isWindows)("on Windows without node:ffi (node --no-experimental-ffi): Intl, with Windows IDs from CLDR", { timeout: 120_000 }, () => {
  it("TZ not set", () => {
    const probe = run(undefined, ["--no-experimental-ffi"]);
    expect(probe.backend).toBe("intl");
    expect(probe.versionId).toMatch(/^Intl: .+ \(Windows IDs from CLDR windowsZones \d+\)$/);
    expect(probe.hasWindowsIds).toBe(true);
    ExpectAgreement(probe);
    // The same zone as with FFI.
    expect(probe.systemDefaultId).toBe(run(undefined).systemDefaultId);
  });

  it("TZ=Asia/Tokyo and TZ=SA Western Standard Time", () => {
    const tokyo = run("Asia/Tokyo", ["--no-experimental-ffi"]);
    expect(tokyo.systemDefaultId).toBe("Tokyo Standard Time");
    ExpectAgreement(tokyo);
    expect(tokyo.provider).toMatchObject({ january: 9 * 3600, july: 9 * 3600 });
    const laPaz = run("SA Western Standard Time", ["--no-experimental-ffi"]);
    expect(laPaz.systemDefaultId).toBe("SA Western Standard Time");
    ExpectAgreement(laPaz);
    expect(laPaz.forSystemDefault).toMatchObject({ january: -4 * 3600, july: -4 * 3600 });
    const unknown = run("Mars/Olympus_Mons", ["--no-experimental-ffi"]);
    expect(unknown.systemDefaultId).toBe("UTC");
    ExpectAgreement(unknown);
    expect(unknown.provider).toMatchObject({ january: 0, july: 0 });
  });
});

describe.runIf(isWindows)("on Windows, each backend by what the process has (the addon package installed or not; node:ffi on or off)", { timeout: 120_000 }, () => {
  // In CI the addon is built before the tests (scripts/build-native.ps1), so a missing build is an error there.
  const requireAddon = (): boolean => {
    if (!addonBuilt && process!.env["CI"]) {
      throw new Error(`The native addon isn't built: run scripts/build-native.ps1 (src/noda-js-win32-${process!.arch})`);
    }
    return addonBuilt;
  };
  const ffiOff = ["--no-experimental-ffi"];

  it("addon installed, node:ffi available: the addon", ({ skip }) => {
    if (!requireAddon()) {
      skip("the native addon isn't built");
    }
    const probe = run(undefined, [], true);
    expect(probe.backend).toBe("addon");
    expect(probe.versionId).toMatch(/noda-js-win32-/);
    ExpectAgreement(probe);
  });

  it("addon installed, node:ffi unavailable: the addon", ({ skip }) => {
    if (!requireAddon()) {
      skip("the native addon isn't built");
    }
    const probe = run(undefined, ffiOff, true);
    expect(probe.backend).toBe("addon");
    ExpectAgreement(probe);
  });

  it("no addon, node:ffi available: node:ffi", () => {
    const probe = run(undefined);
    expect(probe.backend).toBe("ffi");
    expect(probe.versionId).toMatch(/node:ffi/);
    ExpectAgreement(probe);
  });

  it("neither: Intl, with Windows IDs from CLDR", () => {
    const probe = run(undefined, ffiOff);
    expect(probe.backend).toBe("intl");
    expect(probe.hasWindowsIds).toBe(true);
    ExpectAgreement(probe);
  });

  it("the addon and node:ffi read the same data: identical IDs, default, names and offsets, with and without TZ", ({ skip }) => {
    if (!requireAddon()) {
      skip("the native addon isn't built");
    }
    for (const tz of [undefined, "Asia/Tokyo", "SA Western Standard Time", "Mars/Olympus_Mons"]) {
      const ffi = run(tz);
      const addon = run(tz, [], true);
      const addonWithoutFfi = run(tz, ffiOff, true);
      expect([ffi.backend, addon.backend, addonWithoutFfi.backend]).toEqual(["ffi", "addon", "addon"]);
      const { backend: _ffiBackend, versionId: _ffiVersion, ...fromFfi } = ffi;
      const { backend: _addonBackend, versionId: _addonVersion, ...fromAddon } = addon;
      const { backend: _backend, versionId: _version, ...fromAddonWithoutFfi } = addonWithoutFfi;
      expect(fromAddon, `TZ=${tz}`).toEqual(fromFfi);
      expect(fromAddonWithoutFfi, `TZ=${tz}`).toEqual(fromFfi);
    }
  });

  it("Intl agrees with the Windows data on the IDs of the sample zones and their current offsets", () => {
    const ffi = run(undefined);
    const intl = run(undefined, ffiOff);
    expect(intl.systemDefaultId).toBe(ffi.systemDefaultId);
    // Offsets in 2026 (the last two instants); history can differ (IANA rules vs Windows' registry). Morocco is left
    // out: Windows models its permanent +01 (with a return to +00 for Ramadan) differently from tzdb, so even current
    // offsets differ (e.g. January 2026: +00 in Windows' data, +01 in tzdb).
    const current = (samples: unknown) => (samples as [string, unknown, number[]][])
      .filter(([id]) => id !== "Morocco Standard Time")
      .map(([id, , offsets]) => [id, offsets.slice(2)]);
    expect(current(intl.samples)).toEqual(current(ffi.samples));
  });
});
