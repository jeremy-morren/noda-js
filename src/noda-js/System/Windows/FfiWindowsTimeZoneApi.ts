// noda-js: new code. IWindowsTimeZoneApi over a JavaScript runtime's foreign function interface: Node's node:ffi
// (Node 26+, experimental), Bun's bun:ffi or Deno's Deno.dlopen. Everything is reached by feature detection at run
// time (no static imports), so this module loads anywhere; it's only used on Windows.
//
// No BigInt: handles are passed as 64-bit integer arguments given a JavaScript number (registry handles are small;
// HKEY_LOCAL_MACHINE is a negative 32-bit value, sign-extended), and are read back from out-parameters as two 32-bit
// halves. Nothing returns a pointer: string resources are loaded with shlwapi!SHLoadIndirectString, which takes the
// path and resource ID, in place of LoadLibraryExW (whose HMODULE result would be a BigInt).

import type { IWindowsTimeZoneApi, WindowsDynamicTimeZoneInformation, WindowsRegistryValue, WindowsSystemTime } from "./IWindowsTimeZoneApi.ts";
import { GetBuiltinModule, IsWindowsRuntime } from "../Host.ts";

// Deno's global (declared here, as the build has no Deno types).
declare const Deno:
  | {
      readonly dlopen?: (path: string, symbols: Record<string, { parameters: string[]; result: string }>) => { symbols: Record<string, FfiFunction> };
      readonly permissions?: { querySync?: (descriptor: { name: string }) => { state: string } };
    }
  | undefined;

/** The argument types the Win32 functions below use. "buffer": a Uint8Array (or null), passed as a pointer to its bytes. */
type FfiType = "i32" | "u32" | "i64" | "buffer";
type FfiArgument = number | Uint8Array | null;
type FfiFunction = (...args: FfiArgument[]) => number;

interface FfiSignature {
  readonly Arguments: readonly FfiType[];
  readonly Result: "i32" | "u32";
}

/** Loads a DLL's functions with one runtime's FFI. */
interface FfiLoader {
  /** How the runtime's FFI is described in VersionId. */
  readonly Name: string;
  Load(library: string, signatures: Readonly<Record<string, FfiSignature>>): Record<string, FfiFunction>;
}

// #region Win32 constants

/** HKEY_LOCAL_MACHINE: (HKEY)(ULONG_PTR)((LONG)0x80000002), so sign-extended to 64 bits. */
const HKEY_LOCAL_MACHINE = 0x80000002 | 0;
const KEY_READ = 0x20019;
const ERROR_SUCCESS = 0;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const RRF_RT_ANY = 0x0000ffff;
const RRF_NOEXPAND = 0x10000000;
const REG_SZ = 1;
const REG_EXPAND_SZ = 2;
const REG_DWORD = 4;
const MUI_LANGUAGE_NAME = 0x8;
const TIME_ZONE_ID_INVALID = 0xffffffff;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
/** sizeof(DYNAMIC_TIME_ZONE_INFORMATION). */
const DynamicTimeZoneInformationSize = 432;
/** The longest registry key name, in characters (plus the terminating null). */
const MaxKeyNameLength = 256;
/** .NET's LoadStringMaxLength. */
const LoadStringMaxLength = 500;

// #endregion

const Kernel32: Readonly<Record<string, FfiSignature>> = {
  GetDynamicTimeZoneInformation: { Arguments: ["buffer"], Result: "u32" },
  GetSystemDirectoryW: { Arguments: ["buffer", "u32"], Result: "u32" },
  GetUserPreferredUILanguages: { Arguments: ["u32", "buffer", "buffer", "buffer"], Result: "i32" },
  GetFileAttributesW: { Arguments: ["buffer"], Result: "u32" },
};

const Advapi32: Readonly<Record<string, FfiSignature>> = {
  RegOpenKeyExW: { Arguments: ["i64", "buffer", "u32", "u32", "buffer"], Result: "i32" },
  RegEnumKeyExW: { Arguments: ["i64", "u32", "buffer", "buffer", "buffer", "buffer", "buffer", "buffer"], Result: "i32" },
  RegCloseKey: { Arguments: ["i64"], Result: "i32" },
  RegGetValueW: { Arguments: ["i64", "buffer", "buffer", "u32", "buffer", "buffer", "buffer"], Result: "i32" },
};

const Shlwapi: Readonly<Record<string, FfiSignature>> = {
  SHLoadIndirectString: { Arguments: ["buffer", "buffer", "u32", "buffer"], Result: "i32" },
};

/** A null-terminated UTF-16LE string. */
function ToWide(value: string): Uint8Array {
  const bytes = new Uint8Array((value.length + 1) * 2);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    bytes[2 * i] = c & 0xff;
    bytes[2 * i + 1] = c >>> 8;
  }
  return bytes;
}

/** Reads a UTF-16LE string of at most maxChars characters, up to the first null. */
function FromWide(bytes: Uint8Array, offset: number, maxChars: number): string {
  let result = "";
  for (let i = 0; i < maxChars && offset + 2 * i + 1 < bytes.length; i++) {
    const c = bytes[offset + 2 * i]! | (bytes[offset + 2 * i + 1]! << 8);
    if (c === 0) {
      break;
    }
    result += String.fromCharCode(c);
  }
  return result;
}

function Dword(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function ReadDword(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/** @internal Reads a SYSTEMTIME at the given offset of a buffer. */
export function ReadSystemTime(view: DataView, offset: number): WindowsSystemTime {
  return {
    Year: view.getUint16(offset, true),
    Month: view.getUint16(offset + 2, true),
    DayOfWeek: view.getUint16(offset + 4, true),
    Day: view.getUint16(offset + 6, true),
    Hour: view.getUint16(offset + 8, true),
    Minute: view.getUint16(offset + 10, true),
    Second: view.getUint16(offset + 12, true),
    Milliseconds: view.getUint16(offset + 14, true),
  };
}

/** @internal Reads a DYNAMIC_TIME_ZONE_INFORMATION (432 bytes, timezoneapi.h). */
export function ReadDynamicTimeZoneInformation(bytes: Uint8Array): WindowsDynamicTimeZoneInformation {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    Bias: view.getInt32(0, true),
    StandardName: FromWide(bytes, 4, 32),
    StandardDate: ReadSystemTime(view, 68),
    StandardBias: view.getInt32(84, true),
    DaylightName: FromWide(bytes, 88, 32),
    DaylightDate: ReadSystemTime(view, 152),
    DaylightBias: view.getInt32(168, true),
    TimeZoneKeyName: FromWide(bytes, 172, 128),
    DynamicDaylightTimeDisabled: bytes[428] !== 0,
  };
}

/**
 * IWindowsTimeZoneApi over Win32 functions loaded with a runtime's FFI.
 * @internal
 */
export class FfiWindowsTimeZoneApi implements IWindowsTimeZoneApi {
  private readonly _kernel32: Record<string, FfiFunction>;
  private readonly _advapi32: Record<string, FfiFunction>;
  private _shlwapi: Record<string, FfiFunction> | undefined;

  private constructor(private readonly _loader: FfiLoader) {
    this._kernel32 = _loader.Load("kernel32.dll", Kernel32);
    this._advapi32 = _loader.Load("advapi32.dll", Advapi32);
  }

  /** How the runtime's FFI is described in VersionId ("node:ffi", "bun:ffi", "Deno FFI"). */
  get FfiName(): string {
    return this._loader.Name;
  }

  /**
   * The API through the host's FFI, or null if this isn't Windows or the host has no usable FFI (no FFI, FFI disabled,
   * no permission to use it, or a call fails). Calls GetDynamicTimeZoneInformation once to check it works.
   */
  static TryCreate(): FfiWindowsTimeZoneApi | null {
    for (const loader of [NodeFfiLoader, BunFfiLoader, DenoFfiLoader]) {
      try {
        const candidate = loader();
        if (candidate === null) {
          continue;
        }
        const api = new FfiWindowsTimeZoneApi(candidate);
        // A call that must succeed, so that a broken binding falls back to Intl rather than failing later.
        api.GetSystemDirectory();
        return api;
      } catch {
        // Unavailable or not permitted: try the next one.
      }
    }
    return null;
  }

  GetDynamicTimeZoneInformation(): WindowsDynamicTimeZoneInformation | null {
    const buffer = new Uint8Array(DynamicTimeZoneInformationSize);
    const result = this._kernel32["GetDynamicTimeZoneInformation"]!(buffer) >>> 0;
    return result === TIME_ZONE_ID_INVALID ? null : ReadDynamicTimeZoneInformation(buffer);
  }

  GetRegistrySubKeyNames(keyPath: string): readonly string[] | null {
    const key = this.OpenKey(keyPath);
    if (key === null) {
      return null;
    }
    try {
      const names: string[] = [];
      for (let index = 0; ; index++) {
        const name = new Uint8Array(MaxKeyNameLength * 2);
        const length = Dword(MaxKeyNameLength);
        const result = this._advapi32["RegEnumKeyExW"]!(key, index, name, length, null, null, null, null);
        if (result === ERROR_NO_MORE_ITEMS) {
          break;
        }
        if (result !== ERROR_SUCCESS) {
          return null;
        }
        names.push(FromWide(name, 0, ReadDword(length)));
      }
      return names;
    } finally {
      this._advapi32["RegCloseKey"]!(key);
    }
  }

  RegistryKeyExists(keyPath: string): boolean {
    const key = this.OpenKey(keyPath);
    if (key === null) {
      return false;
    }
    this._advapi32["RegCloseKey"]!(key);
    return true;
  }

  GetRegistryValue(keyPath: string, valueName: string): WindowsRegistryValue | null {
    const subKey = ToWide(keyPath);
    const name = ToWide(valueName);
    let size = 1024;
    for (;;) {
      const type = new Uint8Array(4);
      const data = new Uint8Array(size);
      const length = Dword(size);
      const result = this._advapi32["RegGetValueW"]!(HKEY_LOCAL_MACHINE, subKey, name, RRF_RT_ANY | RRF_NOEXPAND, type, data, length);
      if (result === ERROR_MORE_DATA) {
        size = Math.max(ReadDword(length), size * 2);
        continue;
      }
      if (result !== ERROR_SUCCESS) {
        return null;
      }
      const count = ReadDword(length);
      switch (ReadDword(type)) {
        case REG_SZ:
        case REG_EXPAND_SZ:
          return FromWide(data, 0, count / 2);
        case REG_DWORD:
          return ReadDword(data);
        default:
          return data.slice(0, count);
      }
    }
  }

  GetSystemDirectory(): string {
    const buffer = new Uint8Array(1024);
    const length = this._kernel32["GetSystemDirectoryW"]!(buffer, 512) >>> 0;
    return FromWide(buffer, 0, length);
  }

  GetUserPreferredUILanguages(): readonly string[] {
    const count = new Uint8Array(4);
    const length = Dword(1024);
    const buffer = new Uint8Array(2048);
    if (this._kernel32["GetUserPreferredUILanguages"]!(MUI_LANGUAGE_NAME, count, buffer, length) === 0) {
      return [];
    }
    // A multi-string: null-terminated names, then an empty one.
    const languages: string[] = [];
    let offset = 0;
    for (let i = 0; i < ReadDword(count); i++) {
      const language = FromWide(buffer, offset, 1024);
      if (language === "") {
        break;
      }
      languages.push(language);
      offset += (language.length + 1) * 2;
    }
    return languages;
  }

  FileExists(path: string): boolean {
    const attributes = this._kernel32["GetFileAttributesW"]!(ToWide(path)) >>> 0;
    return attributes !== INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0;
  }

  LoadString(filePath: string, resourceId: number): string {
    // SHLoadIndirectString loads the file as a data file and calls LoadString, as .NET does, but takes the path and
    // ID rather than an HMODULE: "@<path>,-<id>".
    this._shlwapi ??= this._loader.Load("shlwapi.dll", Shlwapi);
    const output = new Uint8Array(LoadStringMaxLength * 2);
    const result = this._shlwapi["SHLoadIndirectString"]!(ToWide(`@${filePath},-${resourceId}`), output, LoadStringMaxLength, null);
    return result === 0 ? FromWide(output, 0, LoadStringMaxLength) : "";
  }

  /** RegOpenKeyExW(HKEY_LOCAL_MACHINE, keyPath): the key's handle, or null. */
  private OpenKey(keyPath: string): number | null {
    const handle = new Uint8Array(8);
    if (this._advapi32["RegOpenKeyExW"]!(HKEY_LOCAL_MACHINE, ToWide(keyPath), 0, KEY_READ, handle) !== ERROR_SUCCESS) {
      return null;
    }
    // A HANDLE written as 64 bits. Registry handles are small, so they're exact as a number.
    return ReadDword(handle, 0) + ReadDword(handle, 4) * 0x100000000;
  }
}

// #region Loaders

/** Node 26+'s experimental node:ffi (unavailable with --no-experimental-ffi, and under the permission model without --allow-ffi). */
function NodeFfiLoader(): FfiLoader | null {
  if (!IsWindowsRuntime()) {
    return null;
  }
  const ffi = GetBuiltinModule("node:ffi") as
    | { dlopen?: (path: string, definitions: Record<string, { arguments: string[]; return: string }>) => { functions: Record<string, FfiFunction> } }
    | undefined;
  if (ffi === undefined || ffi === null || typeof ffi.dlopen !== "function") {
    return null;
  }
  const dlopen = ffi.dlopen;
  const types: Record<FfiType | "i32" | "u32", string> = { i32: "int32", u32: "uint32", i64: "int64", buffer: "arraybuffer" };
  return {
    Name: "node:ffi",
    Load(library, signatures) {
      const definitions: Record<string, { arguments: string[]; return: string }> = {};
      for (const name of Object.keys(signatures)) {
        const signature = signatures[name]!;
        definitions[name] = { arguments: signature.Arguments.map(type => types[type]), return: types[signature.Result] };
      }
      return dlopen(library, definitions).functions;
    },
  };
}

/** Bun's bun:ffi, where the runtime exposes it through process.getBuiltinModule. */
function BunFfiLoader(): FfiLoader | null {
  if (!IsWindowsRuntime()) {
    return null;
  }
  let ffi: { dlopen?: (path: string, symbols: Record<string, { args: string[]; returns: string }>) => { symbols: Record<string, FfiFunction> } } | undefined;
  try {
    ffi = GetBuiltinModule("bun:ffi") as typeof ffi;
  } catch {
    return null;
  }
  if (ffi === undefined || ffi === null || typeof ffi.dlopen !== "function") {
    return null;
  }
  const dlopen = ffi.dlopen;
  // Bun passes a TypedArray (or null) given for a "ptr" argument as a pointer to its bytes.
  const types: Record<FfiType | "i32" | "u32", string> = { i32: "i32", u32: "u32", i64: "i64", buffer: "ptr" };
  return {
    Name: "bun:ffi",
    Load(library, signatures) {
      const symbols: Record<string, { args: string[]; returns: string }> = {};
      for (const name of Object.keys(signatures)) {
        const signature = signatures[name]!;
        symbols[name] = { args: signature.Arguments.map(type => types[type]), returns: types[signature.Result] };
      }
      return dlopen(library, symbols).symbols;
    },
  };
}

/** Deno's Deno.dlopen, when the FFI permission has been granted (it isn't requested, so there's never a prompt). */
function DenoFfiLoader(): FfiLoader | null {
  if (typeof Deno === "undefined" || Deno === undefined || typeof Deno.dlopen !== "function" || !IsWindowsRuntime()) {
    return null;
  }
  if (Deno.permissions?.querySync?.({ name: "ffi" }).state !== "granted") {
    return null;
  }
  const dlopen = Deno.dlopen;
  const types: Record<FfiType | "i32" | "u32", string> = { i32: "i32", u32: "u32", i64: "i64", buffer: "buffer" };
  return {
    Name: "Deno FFI",
    Load(library, signatures) {
      const symbols: Record<string, { parameters: string[]; result: string }> = {};
      for (const name of Object.keys(signatures)) {
        const signature = signatures[name]!;
        symbols[name] = { parameters: signature.Arguments.map(type => types[type]), result: types[signature.Result] };
      }
      return dlopen(library, symbols).symbols;
    },
  };
}

// #endregion
