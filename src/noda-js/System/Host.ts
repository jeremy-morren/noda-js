// noda-js: new code. What noda-js/system needs to know about the host it runs on, found by feature detection (no
// static imports of host modules, so this loads anywhere).

// The hosts' globals (declared here, as the build has no Node, Bun or Deno types).
declare const process:
  | {
      readonly platform?: string;
      readonly arch?: string;
      readonly versions?: { readonly node?: unknown; readonly bun?: unknown };
      readonly getBuiltinModule?: (id: string) => unknown;
    }
  | undefined;
declare const Deno: { readonly build?: { readonly os?: string } } | undefined;

/**
 * Whether this is a server-side runtime (Node, Bun or Deno) on Windows. A browser is never one, whatever OS it runs on
 * (as .NET in a browser uses IANA IDs), nor is a bundler's `process` shim (which has no `versions.node`).
 * @internal
 */
export function IsWindowsRuntime(): boolean {
  if (typeof Deno !== "undefined" && typeof Deno?.build?.os === "string") {
    return Deno.build.os === "windows";
  }
  if (typeof process === "undefined" || process === null || process.platform !== "win32") {
    return false;
  }
  const versions = process.versions;
  return versions !== undefined && (typeof versions.node === "string" || typeof versions.bun === "string");
}

/** process.getBuiltinModule(id) where the host has it (Node 22.3+, Bun, Deno), else undefined. @internal */
export function GetBuiltinModule(id: string): unknown {
  if (typeof process === "undefined" || process === null || typeof process.getBuiltinModule !== "function") {
    return undefined;
  }
  return process.getBuiltinModule(id);
}

/** process.arch ("x64", "arm64", ...), or undefined. @internal */
export function GetProcessArchitecture(): string | undefined {
  return typeof process === "undefined" || process === null ? undefined : process.arch;
}
