// Ported from NodaTime 3.3.7: src/NodaTime/TimeZones/TimeZoneInfoInterceptor.cs
// Copyright 2017 The Noda Time Authors. All rights reserved.
// Use of this source code is governed by the Apache License 2.0,
// as found in the LICENSE.txt file.

import { NewInvalidOperationException } from "../internal.ts";
import type { TimeZoneInfo } from "../System/TimeZoneInfo.ts";
import { TimeZoneInfoCachedData } from "../System/TimeZoneInfo.Win32.ts";
import { FindWindowsTimeZoneApi, type SystemTimeZoneBackend, type WindowsTimeZoneApiBackend } from "../System/Windows/WindowsTimeZoneApi.ts";

/**
 * The shim to use for all the static methods.
 *
 * noda-js: undefined until first use; null when the host can't read Windows' time zones (noda-js/system then uses
 * Intl, which has no TimeZoneInfo).
 */
let shim: ITimeZoneInfoShim | null | undefined;

/**
 * Interception for TimeZoneInfo static methods. These are still represented as
 * static methods in this class, but they're implemented via a replaceable shim, which
 * by default delegates to the static methods in TimeZoneInfo.
 *
 * noda-js: the default shim reads Windows' time zones (as .NET's TimeZoneInfo does) through the first way the host
 * has: the native addon, then FFI. Tests replace it, as NodaTime's do.
 * @internal
 */
export class TimeZoneInfoInterceptor {
  private constructor() {}

  /**
   * The shim to use for all the static methods. We don't care about thread safety here,
   * beyond "it must be correct when used in production" - it's only ever changed in tests,
   * which are single-threaded anyway.
   *
   * noda-js: null if the host can't read Windows' time zones.
   */
  static get Shim(): ITimeZoneInfoShim | null {
    if (shim === undefined) {
      const backend = FindWindowsTimeZoneApi();
      shim = backend === null ? null : new BclShim(backend);
    }
    return shim;
  }

  static set Shim(value: ITimeZoneInfoShim | null) {
    shim = value;
  }

  static get Local(): TimeZoneInfo | null {
    return TimeZoneInfoInterceptor.RequireShim().Local;
  }

  static FindSystemTimeZoneById(id: string): TimeZoneInfo {
    return TimeZoneInfoInterceptor.RequireShim().FindSystemTimeZoneById(id);
  }

  static GetSystemTimeZones(): readonly TimeZoneInfo[] {
    return TimeZoneInfoInterceptor.RequireShim().GetSystemTimeZones();
  }

  private static RequireShim(): ITimeZoneInfoShim {
    const current = TimeZoneInfoInterceptor.Shim;
    if (current === null) {
      throw NewInvalidOperationException("There is no TimeZoneInfo on this host");
    }
    return current;
  }
}

/** @internal */
export interface ITimeZoneInfoShim {
  readonly Local: TimeZoneInfo | null;
  FindSystemTimeZoneById(id: string): TimeZoneInfo;
  GetSystemTimeZones(): readonly TimeZoneInfo[];

  /** noda-js: where the zones come from (for SystemDateTimeZoneSource.Backend). */
  readonly Backend: SystemTimeZoneBackend;
  /** noda-js: how they're read, for VersionId (e.g. "node:ffi"). */
  readonly Description: string;
}

/**
 * Implementation that just delegates in a simple manner.
 *
 * noda-js: to the port of TimeZoneInfo's Windows implementation, over the host's Windows API.
 */
class BclShim implements ITimeZoneInfoShim {
  private readonly _data: TimeZoneInfoCachedData;

  constructor(private readonly _backend: WindowsTimeZoneApiBackend) {
    this._data = new TimeZoneInfoCachedData(_backend.Api);
  }

  get Local(): TimeZoneInfo | null {
    return this._data.Local;
  }

  FindSystemTimeZoneById(id: string): TimeZoneInfo {
    return this._data.FindSystemTimeZoneById(id);
  }

  GetSystemTimeZones(): readonly TimeZoneInfo[] {
    return this._data.GetSystemTimeZones();
  }

  get Backend(): SystemTimeZoneBackend {
    return this._backend.Backend;
  }

  get Description(): string {
    return this._backend.Description;
  }
}

/**
 * A shim over a given Windows API (for tests: fake Windows data through the same code as the real thing).
 * @internal
 */
export function CreateWindowsTimeZoneInfoShim(backend: WindowsTimeZoneApiBackend): ITimeZoneInfoShim {
  return new BclShim(backend);
}
