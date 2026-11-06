// noda-js: new code. The TZ environment variable, read by feature detection (process.env under Node and Bun,
// Deno.env, which needs the env permission, under Deno); browsers have none. The system and tzdb providers'
// GetSystemDefault honour it (see docs/Timezones.md).

// The hosts' globals (declared here, as the build has no Node or Deno types).
declare const process: { readonly env?: Readonly<Record<string, string | undefined>> } | undefined;
declare const Deno:
  | {
      readonly env?: { get?: (name: string) => string | undefined };
      readonly permissions?: { querySync?: (descriptor: { name: string; variable?: string }) => { state: string } };
    }
  | undefined;

/** For tests: what the TZ environment variable reads as instead of the host's (see ReplaceTZEnvironmentVariable). */
let replacement: { readonly value: string | undefined } | null = null;

/**
 * For tests: makes {@link GetTZEnvironmentVariable} read `value` (undefined: not set) instead of the host's TZ, until
 * the returned function is called. (Changing process.env.TZ instead would also reset Node's Intl default zone.)
 * @internal
 */
export function ReplaceTZEnvironmentVariable(value: string | undefined): () => void {
  const previous = replacement;
  replacement = { value };
  return () => {
    replacement = previous;
  };
}

/**
 * The TZ environment variable, with a leading ":" removed (as on Unix, where ":Europe/London" names a zone file);
 * null if it isn't set, is empty, or can't be read.
 * @internal
 */
export function GetTZEnvironmentVariable(): string | null {
  return Normalize(replacement !== null ? replacement.value : ReadHostTZ());
}

/** The host's TZ environment variable, if it can be read. */
function ReadHostTZ(): string | undefined {
  let value: string | undefined;
  try {
    if (typeof Deno !== "undefined" && Deno !== null && typeof Deno.env?.get === "function") {
      // Only with the permission already granted, so there's never a prompt.
      if (Deno.permissions?.querySync?.({ name: "env", variable: "TZ" }).state !== "granted") {
        return undefined;
      }
      value = Deno.env.get("TZ");
    } else if (typeof process !== "undefined" && process !== null && typeof process.env === "object" && process.env !== null) {
      value = process.env["TZ"];
    }
  } catch {
    // No permission (Deno): as if it weren't set.
    return undefined;
  }
  return value;
}

/** A leading ":" removed; null for unset or empty. */
function Normalize(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.charAt(0) === ":") {
    value = value.substring(1);
  }
  return value === "" ? null : value;
}
