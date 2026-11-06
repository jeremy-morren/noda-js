// noda-js: the `noda-js/system` entry point: the host system's time zones, as NodaTime's BclDateTimeZoneSource,
// BclDateTimeZone and DateTimeZoneProviders.Bcl give them on .NET (renamed SystemDateTimeZoneSource,
// SystemDateTimeZone and SystemDateTimeZoneProvider). On Windows, Windows' own zones, read as .NET's TimeZoneInfo
// reads them (through the native addon or the runtime's FFI); elsewhere, the host's Intl zones. See docs/Timezones.md.

import { DateTimeZoneCache, SystemDateTimeZoneSource } from "../internal.ts";
import type { IDateTimeZoneProvider } from "../internal.ts";

export { SystemDateTimeZone, SystemDateTimeZoneSource, TimeZoneInfo, TimeZoneInfoAdjustmentRule, TimeZoneInfoTransitionTime } from "../internal.ts";
export type { InvalidTimeZoneException } from "../internal.ts";

/**
 * Returns an object that forwards every property access to the value created by `factory`, which is called
 * on first access. `instanceof` checks see the real object's prototype.
 */
function Lazy<T extends object>(factory: () => T): T {
  let value: T | undefined;
  const get = (): T => (value ??= factory());
  return new Proxy({} as T, {
    get(_target, property) {
      const target = get();
      const result: unknown = Reflect.get(target, property, target);
      return typeof result === "function" && property !== "constructor" ? (result as (...args: unknown[]) => unknown).bind(target) : result;
    },
    has(_target, property) {
      return Reflect.has(get(), property);
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(get()) as object | null;
    },
  });
}

/**
 * A time zone provider for the host system's time zones (the equivalent of NodaTime's `DateTimeZoneProviders.Bcl`):
 * a {@link DateTimeZoneCache} over a {@link SystemDateTimeZoneSource}, created on first use (which is when the source
 * decides where the zones come from).
 */
export const SystemDateTimeZoneProvider: IDateTimeZoneProvider = /*#__PURE__*/ Lazy(() => new DateTimeZoneCache(new SystemDateTimeZoneSource()));
