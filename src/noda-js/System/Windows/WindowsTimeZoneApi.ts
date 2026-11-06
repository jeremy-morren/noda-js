// noda-js: new code. Finds the way noda-js/system reads Windows' time zone data on this host, by what the host actually
// has, at first use: the native addon package (noda-js-win32-<arch>) if it's installed, then the runtime's FFI
// (node:ffi, bun:ffi, Deno.dlopen), otherwise none (noda-js/system then uses Intl).

import type { IWindowsTimeZoneApi } from "./IWindowsTimeZoneApi.ts";
import { FfiWindowsTimeZoneApi } from "./FfiWindowsTimeZoneApi.ts";
import { GetBuiltinModule, GetProcessArchitecture, IsWindowsRuntime } from "../Host.ts";

/**
 * Where noda-js/system gets its time zones: "addon" (the noda-js-win32-x64 or noda-js-win32-arm64 package), "ffi"
 * (the runtime's foreign function interface), both reading Windows' data as .NET's TimeZoneInfo does, or "intl" (the
 * host's Intl).
 */
export type SystemTimeZoneBackend = "addon" | "ffi" | "intl";

/** A way to read Windows' time zone data. @internal */
export interface WindowsTimeZoneApiBackend {
  readonly Backend: Exclude<SystemTimeZoneBackend, "intl">;
  /** For VersionId: e.g. "node:ffi", or the addon's package name. */
  readonly Description: string;
  readonly Api: IWindowsTimeZoneApi;
}

/**
 * The package name of the native addon for this process's architecture, e.g. "noda-js-win32-x64".
 * @internal
 */
export function GetAddonPackageName(): string | null {
  const arch = GetProcessArchitecture();
  return arch === "x64" || arch === "arm64" ? `noda-js-win32-${arch}` : null;
}

/**
 * The native addon's IWindowsTimeZoneApi, if its package is installed and loads: resolved by package name at run time
 * with module.createRequire, relative to this module (so it's found wherever npm installed noda-js's optional
 * dependencies). The package's export is expected to be an object implementing IWindowsTimeZoneApi.
 */
function TryLoadAddon(): WindowsTimeZoneApiBackend | null {
  const name = GetAddonPackageName();
  if (name === null) {
    return null;
  }
  try {
    const module = GetBuiltinModule("module") as { createRequire?: (path: string) => (id: string) => unknown } | undefined;
    if (module === undefined || module === null || typeof module.createRequire !== "function") {
      return null;
    }
    // eslint-disable-next-line es-x/no-import-meta -- ES module output; only reached on Node, Bun and Deno
    const require = module.createRequire(import.meta.url);
    const addon = require(name) as Partial<IWindowsTimeZoneApi> | null;
    if (addon === null || typeof addon !== "object" || typeof addon.GetDynamicTimeZoneInformation !== "function") {
      return null;
    }
    return { Backend: "addon", Description: name, Api: addon as IWindowsTimeZoneApi };
  } catch {
    // Not installed, or it doesn't load (wrong architecture, no native addons): fall back.
    return null;
  }
}

function TryLoadFfi(): WindowsTimeZoneApiBackend | null {
  const api = FfiWindowsTimeZoneApi.TryCreate();
  return api === null ? null : { Backend: "ffi", Description: api.FfiName, Api: api };
}

/**
 * The first way of reading Windows' time zone data this host has: the native addon, then FFI. Null if this isn't a
 * Windows runtime (browsers never are), or neither is available.
 * @internal
 */
export function FindWindowsTimeZoneApi(): WindowsTimeZoneApiBackend | null {
  if (!IsWindowsRuntime()) {
    return null;
  }
  return TryLoadAddon() ?? TryLoadFfi();
}
