// Ported from NodaTime 3.3.7: src/NodaTime.Test/TimeZones/TimeZoneInfoReplacer.cs
// Copyright 2012 The Noda Time Authors. All rights reserved.
// Use of this source code is governed by the Apache License 2.0,
// as found in the LICENSE.txt file.
//
// noda-js: IDisposable is a function to call (in a finally block); `using` blocks are try/finally.

import { NewTimeZoneNotFoundException, TimeZoneInfoInterceptor, type ITimeZoneInfoShim, type TimeZoneInfo } from "../../../src/noda-js/internal.ts";

/**
 * Class used to temporarily replace the shim used by {@link TimeZoneInfoInterceptor},
 * for test purposes. On disposal, the original is restored.
 */
export class TimeZoneInfoReplacer implements ITimeZoneInfoShim {
  private readonly _originalShim: ITimeZoneInfoShim | null;

  readonly Backend = "ffi" as const;
  readonly Description = "TimeZoneInfoReplacer";

  private constructor(readonly Local: TimeZoneInfo | null, private readonly _zones: readonly TimeZoneInfo[]) {
    this._originalShim = TimeZoneInfoInterceptor.Shim;
    TimeZoneInfoInterceptor.Shim = this;
  }

  /** Replaces the shim; call the result to restore it. */
  static Replace(local: TimeZoneInfo | null, ...allZones: TimeZoneInfo[]): () => void {
    const replacer = new TimeZoneInfoReplacer(local, allZones);
    return () => replacer.Dispose();
  }

  /** Replaces the shim with another one (e.g. over a fake Windows); call the result to restore it. noda-js addition. */
  static ReplaceShim(shim: ITimeZoneInfoShim | null): () => void {
    const original = TimeZoneInfoInterceptor.Shim;
    TimeZoneInfoInterceptor.Shim = shim;
    return () => {
      TimeZoneInfoInterceptor.Shim = original;
    };
  }

  FindSystemTimeZoneById(id: string): TimeZoneInfo {
    const zone = this._zones.find(z => z.Id === id);
    if (zone !== undefined) {
      return zone;
    }
    throw NewTimeZoneNotFoundException(`No such time zone: ${id}`);
  }

  GetSystemTimeZones(): readonly TimeZoneInfo[] {
    return this._zones;
  }

  Dispose(): void {
    TimeZoneInfoInterceptor.Shim = this._originalShim;
  }
}
