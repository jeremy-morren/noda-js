// noda-js: new code. The Windows calls noda-js/system makes to read the time zone data .NET's TimeZoneInfo reads on
// Windows (System.TimeZoneInfo, in TimeZoneInfo.Win32.cs), as plain JavaScript values.
//
// Each operation maps onto one Win32 call (or a fixed sequence of them), so that every implementation (node:ffi, Deno's
// and Bun's FFI, a native addon, or a test's fake) returns exactly what Windows does, and the logic that interprets the
// data (ported from .NET) stays in one place: System/TimeZoneInfo.Win32.ts. No BigInt and no raw pointers cross it.

/** A Win32 SYSTEMTIME (minwinbase.h): every field is a WORD. */
export interface WindowsSystemTime {
  readonly Year: number;
  readonly Month: number;
  readonly DayOfWeek: number;
  readonly Day: number;
  readonly Hour: number;
  readonly Minute: number;
  readonly Second: number;
  readonly Milliseconds: number;
}

/** A Win32 DYNAMIC_TIME_ZONE_INFORMATION (timezoneapi.h), as GetDynamicTimeZoneInformation fills it. */
export interface WindowsDynamicTimeZoneInformation {
  readonly Bias: number;
  readonly StandardName: string;
  readonly StandardDate: WindowsSystemTime;
  readonly StandardBias: number;
  readonly DaylightName: string;
  readonly DaylightDate: WindowsSystemTime;
  readonly DaylightBias: number;
  readonly TimeZoneKeyName: string;
  readonly DynamicDaylightTimeDisabled: boolean;
}

/**
 * A registry value: a string for REG_SZ and REG_EXPAND_SZ (not expanded), a number for REG_DWORD, and the bytes for
 * anything else (REG_BINARY, such as the "TZI" values).
 */
export type WindowsRegistryValue = string | number | Uint8Array;

/**
 * The Windows calls noda-js/system makes. Registry paths are relative to HKEY_LOCAL_MACHINE, without a trailing
 * backslash (e.g. "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Time Zones"). Implementations must not throw for
 * a missing key, value or file: they return null (or false, or "").
 */
export interface IWindowsTimeZoneApi {
  /**
   * kernel32!GetDynamicTimeZoneInformation: the current time zone settings, or null if it returns
   * TIME_ZONE_ID_INVALID.
   */
  GetDynamicTimeZoneInformation(): WindowsDynamicTimeZoneInformation | null;

  /**
   * advapi32!RegOpenKeyExW(HKEY_LOCAL_MACHINE, keyPath, KEY_READ) then RegEnumKeyExW: the names of the key's subkeys,
   * in the order RegEnumKeyExW returns them; null if the key can't be opened.
   */
  GetRegistrySubKeyNames(keyPath: string): readonly string[] | null;

  /** advapi32!RegOpenKeyExW(HKEY_LOCAL_MACHINE, keyPath, KEY_READ): whether the key can be opened. */
  RegistryKeyExists(keyPath: string): boolean;

  /**
   * advapi32!RegGetValueW(HKEY_LOCAL_MACHINE, keyPath, valueName, RRF_RT_ANY | RRF_NOEXPAND): the value, or null if
   * the key or value doesn't exist.
   */
  GetRegistryValue(keyPath: string, valueName: string): WindowsRegistryValue | null;

  /** kernel32!GetSystemDirectoryW (.NET's Environment.SystemDirectory), e.g. "C:\\Windows\\system32". */
  GetSystemDirectory(): string;

  /**
   * kernel32!GetUserPreferredUILanguages(MUI_LANGUAGE_NAME): the user's UI languages, most preferred first (the first
   * is .NET's CultureInfo.CurrentUICulture on Windows).
   */
  GetUserPreferredUILanguages(): readonly string[];

  /** kernel32!GetFileAttributesW: whether the file exists (and isn't a directory), as .NET's File.Exists. */
  FileExists(path: string): boolean;

  /**
   * kernel32!LoadLibraryExW(filePath, LOAD_LIBRARY_AS_DATAFILE), user32!LoadStringW(resourceId, 500 characters), then
   * FreeLibrary: the string resource, or "" if the file can't be loaded or has no such string.
   */
  LoadString(filePath: string, resourceId: number): string;
}
