// noda-js: new code. The native addon behind the optional packages noda-js-win32-x64 and noda-js-win32-arm64: the
// Windows calls noda-js/system makes to read the time zone data .NET's TimeZoneInfo reads, as a Node-API module. It
// implements IWindowsTimeZoneApi (src/noda-js/System/Windows/IWindowsTimeZoneApi.ts), whose documentation defines
// each operation; the node:ffi implementation (FfiWindowsTimeZoneApi.ts) makes the same calls.
//
// Node-API is ABI-stable, so one build works with every Node version that supports NAPI_VERSION (and with Bun and
// Deno, which load Node-API modules).

#define NAPI_VERSION 8
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
#include <node_api.h>

// .NET's LoadStringMaxLength (TimeZoneInfo.Win32.cs).
#define LOAD_STRING_MAX_LENGTH 500
// The longest registry key name (MSDN: 255 characters).
#define MAX_KEY_LENGTH 256
// The longest path read from JavaScript.
#define MAX_PATH_LENGTH 32768

// Returns early from a Node-API callback when a call fails (the pending exception, if any, is thrown in JS).
#define CHECK(call)                \
  do {                             \
    if ((call) != napi_ok) {       \
      return NULL;                 \
    }                              \
  } while (0)

static napi_value Null(napi_env env) {
  napi_value value;
  napi_get_null(env, &value);
  return value;
}

static napi_value Boolean(napi_env env, BOOL b) {
  napi_value value;
  napi_get_boolean(env, b ? true : false, &value);
  return value;
}

static napi_value Int32(napi_env env, int32_t n) {
  napi_value value;
  napi_create_int32(env, n, &value);
  return value;
}

static napi_value Uint32(napi_env env, uint32_t n) {
  napi_value value;
  napi_create_uint32(env, n, &value);
  return value;
}

/** A JS string from a wide string, up to its first NUL or `maxLength` characters (as the FFI implementation reads). */
static napi_value WideString(napi_env env, const WCHAR* text, size_t maxLength) {
  size_t length = 0;
  while (length < maxLength && text[length] != L'\0') {
    length++;
  }
  napi_value value;
  napi_create_string_utf16(env, (const char16_t*) text, length, &value);
  return value;
}

static void SetProperty(napi_env env, napi_value object, const char* name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}

/** A string argument as a NUL-terminated wide string; returns NULL (with a JS exception pending) if it isn't one. */
static WCHAR* GetWideArgument(napi_env env, napi_callback_info info, size_t index) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || index >= argc) {
    napi_throw_type_error(env, NULL, "Missing string argument");
    return NULL;
  }
  size_t length;
  if (napi_get_value_string_utf16(env, argv[index], NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected a string argument");
    return NULL;
  }
  if (length >= MAX_PATH_LENGTH) {
    napi_throw_range_error(env, NULL, "String argument too long");
    return NULL;
  }
  WCHAR* text = (WCHAR*) HeapAlloc(GetProcessHeap(), 0, (length + 1) * sizeof(WCHAR));
  if (text == NULL) {
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  napi_get_value_string_utf16(env, argv[index], (char16_t*) text, length + 1, &length);
  return text;
}

static void FreeWide(WCHAR* text) {
  if (text != NULL) {
    HeapFree(GetProcessHeap(), 0, text);
  }
}

static napi_value SystemTime(napi_env env, const SYSTEMTIME* time) {
  napi_value object;
  napi_create_object(env, &object);
  SetProperty(env, object, "Year", Uint32(env, time->wYear));
  SetProperty(env, object, "Month", Uint32(env, time->wMonth));
  SetProperty(env, object, "DayOfWeek", Uint32(env, time->wDayOfWeek));
  SetProperty(env, object, "Day", Uint32(env, time->wDay));
  SetProperty(env, object, "Hour", Uint32(env, time->wHour));
  SetProperty(env, object, "Minute", Uint32(env, time->wMinute));
  SetProperty(env, object, "Second", Uint32(env, time->wSecond));
  SetProperty(env, object, "Milliseconds", Uint32(env, time->wMilliseconds));
  return object;
}

/** kernel32!GetDynamicTimeZoneInformation: the current settings, or null for TIME_ZONE_ID_INVALID. */
static napi_value GetDynamicTimeZoneInformationJs(napi_env env, napi_callback_info info) {
  (void) info;
  DYNAMIC_TIME_ZONE_INFORMATION dtzi;
  ZeroMemory(&dtzi, sizeof dtzi);
  if (GetDynamicTimeZoneInformation(&dtzi) == TIME_ZONE_ID_INVALID) {
    return Null(env);
  }
  napi_value object;
  CHECK(napi_create_object(env, &object));
  SetProperty(env, object, "Bias", Int32(env, dtzi.Bias));
  SetProperty(env, object, "StandardName", WideString(env, dtzi.StandardName, ARRAYSIZE(dtzi.StandardName)));
  SetProperty(env, object, "StandardDate", SystemTime(env, &dtzi.StandardDate));
  SetProperty(env, object, "StandardBias", Int32(env, dtzi.StandardBias));
  SetProperty(env, object, "DaylightName", WideString(env, dtzi.DaylightName, ARRAYSIZE(dtzi.DaylightName)));
  SetProperty(env, object, "DaylightDate", SystemTime(env, &dtzi.DaylightDate));
  SetProperty(env, object, "DaylightBias", Int32(env, dtzi.DaylightBias));
  SetProperty(env, object, "TimeZoneKeyName", WideString(env, dtzi.TimeZoneKeyName, ARRAYSIZE(dtzi.TimeZoneKeyName)));
  SetProperty(env, object, "DynamicDaylightTimeDisabled", Boolean(env, dtzi.DynamicDaylightTimeDisabled));
  return object;
}

/** advapi32!RegOpenKeyExW + RegEnumKeyExW: the subkey names, or null if the key can't be opened. */
static napi_value GetRegistrySubKeyNamesJs(napi_env env, napi_callback_info info) {
  WCHAR* keyPath = GetWideArgument(env, info, 0);
  if (keyPath == NULL) {
    return NULL;
  }
  HKEY key;
  LSTATUS status = RegOpenKeyExW(HKEY_LOCAL_MACHINE, keyPath, 0, KEY_READ, &key);
  FreeWide(keyPath);
  if (status != ERROR_SUCCESS) {
    return Null(env);
  }
  napi_value names;
  if (napi_create_array(env, &names) != napi_ok) {
    RegCloseKey(key);
    return NULL;
  }
  WCHAR name[MAX_KEY_LENGTH];
  for (DWORD index = 0;; index++) {
    DWORD length = MAX_KEY_LENGTH;
    status = RegEnumKeyExW(key, index, name, &length, NULL, NULL, NULL, NULL);
    if (status != ERROR_SUCCESS) {
      // ERROR_NO_MORE_ITEMS at the end; anything else ends the enumeration too, as .NET's GetSubKeyNames would fail.
      break;
    }
    napi_set_element(env, names, index, WideString(env, name, length));
  }
  RegCloseKey(key);
  return names;
}

/** advapi32!RegOpenKeyExW: whether the key can be opened. */
static napi_value RegistryKeyExistsJs(napi_env env, napi_callback_info info) {
  WCHAR* keyPath = GetWideArgument(env, info, 0);
  if (keyPath == NULL) {
    return NULL;
  }
  HKEY key;
  LSTATUS status = RegOpenKeyExW(HKEY_LOCAL_MACHINE, keyPath, 0, KEY_READ, &key);
  FreeWide(keyPath);
  if (status == ERROR_SUCCESS) {
    RegCloseKey(key);
  }
  return Boolean(env, status == ERROR_SUCCESS);
}

/**
 * advapi32!RegGetValueW(RRF_RT_ANY | RRF_NOEXPAND): a string for REG_SZ and REG_EXPAND_SZ (up to the first NUL), an
 * unsigned number for REG_DWORD, a Uint8Array for anything else; null if the key or value doesn't exist.
 */
static napi_value GetRegistryValueJs(napi_env env, napi_callback_info info) {
  WCHAR* keyPath = GetWideArgument(env, info, 0);
  if (keyPath == NULL) {
    return NULL;
  }
  WCHAR* valueName = GetWideArgument(env, info, 1);
  if (valueName == NULL) {
    FreeWide(keyPath);
    return NULL;
  }
  DWORD type = 0;
  DWORD size = 0;
  BYTE* data = NULL;
  LSTATUS status = RegGetValueW(HKEY_LOCAL_MACHINE, keyPath, valueName, RRF_RT_ANY | RRF_NOEXPAND, &type, NULL, &size);
  // The value can grow between the two calls; retry with the new size.
  for (int attempt = 0; status == ERROR_SUCCESS && attempt < 4; attempt++) {
    data = (BYTE*) HeapAlloc(GetProcessHeap(), 0, size + sizeof(WCHAR));
    if (data == NULL) {
      status = ERROR_OUTOFMEMORY;
      break;
    }
    status = RegGetValueW(HKEY_LOCAL_MACHINE, keyPath, valueName, RRF_RT_ANY | RRF_NOEXPAND, &type, data, &size);
    if (status != ERROR_MORE_DATA) {
      break;
    }
    HeapFree(GetProcessHeap(), 0, data);
    data = NULL;
    status = RegGetValueW(HKEY_LOCAL_MACHINE, keyPath, valueName, RRF_RT_ANY | RRF_NOEXPAND, &type, NULL, &size);
  }
  FreeWide(keyPath);
  FreeWide(valueName);
  if (status != ERROR_SUCCESS || data == NULL) {
    if (data != NULL) {
      HeapFree(GetProcessHeap(), 0, data);
    }
    return Null(env);
  }
  napi_value result;
  switch (type) {
    case REG_SZ:
    case REG_EXPAND_SZ:
      result = WideString(env, (const WCHAR*) data, size / sizeof(WCHAR));
      break;
    case REG_DWORD:
      result = Uint32(env, size >= sizeof(DWORD) ? *(const DWORD*) data : 0);
      break;
    default: {
      void* bytes;
      napi_value buffer;
      if (napi_create_arraybuffer(env, size, &bytes, &buffer) != napi_ok ||
          napi_create_typedarray(env, napi_uint8_array, size, buffer, 0, &result) != napi_ok) {
        HeapFree(GetProcessHeap(), 0, data);
        return NULL;
      }
      CopyMemory(bytes, data, size);
      break;
    }
  }
  HeapFree(GetProcessHeap(), 0, data);
  return result;
}

/** kernel32!GetSystemDirectoryW. */
static napi_value GetSystemDirectoryJs(napi_env env, napi_callback_info info) {
  (void) info;
  WCHAR directory[MAX_PATH + 1];
  UINT length = GetSystemDirectoryW(directory, ARRAYSIZE(directory));
  return WideString(env, directory, length < ARRAYSIZE(directory) ? length : 0);
}

/** kernel32!GetUserPreferredUILanguages(MUI_LANGUAGE_NAME): the language names, most preferred first. */
static napi_value GetUserPreferredUILanguagesJs(napi_env env, napi_callback_info info) {
  (void) info;
  napi_value languages;
  CHECK(napi_create_array(env, &languages));
  ULONG count = 0;
  ULONG length = 0;
  if (!GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &count, NULL, &length) || length == 0) {
    return languages;
  }
  WCHAR* buffer = (WCHAR*) HeapAlloc(GetProcessHeap(), 0, length * sizeof(WCHAR));
  if (buffer == NULL) {
    return languages;
  }
  if (GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &count, buffer, &length)) {
    // A multi-string: NUL-terminated names, then an empty one.
    const WCHAR* name = buffer;
    for (uint32_t index = 0; index < count && *name != L'\0'; index++) {
      size_t nameLength = lstrlenW(name);
      napi_set_element(env, languages, index, WideString(env, name, nameLength));
      name += nameLength + 1;
    }
  }
  HeapFree(GetProcessHeap(), 0, buffer);
  return languages;
}

/** kernel32!GetFileAttributesW: whether the path exists and isn't a directory (.NET's File.Exists). */
static napi_value FileExistsJs(napi_env env, napi_callback_info info) {
  WCHAR* path = GetWideArgument(env, info, 0);
  if (path == NULL) {
    return NULL;
  }
  DWORD attributes = GetFileAttributesW(path);
  FreeWide(path);
  return Boolean(env, attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0);
}

/**
 * kernel32!LoadLibraryExW(LOAD_LIBRARY_AS_DATAFILE), user32!LoadStringW (500 characters), FreeLibrary: the string
 * resource, or "" if the file can't be loaded or has no such string (as .NET's TryGetLocalizedNameByNativeResource).
 */
static napi_value LoadStringJs(napi_env env, napi_callback_info info) {
  WCHAR* path = GetWideArgument(env, info, 0);
  if (path == NULL) {
    return NULL;
  }
  size_t argc = 2;
  napi_value argv[2];
  int32_t resourceId = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2 ||
      napi_get_value_int32(env, argv[1], &resourceId) != napi_ok) {
    FreeWide(path);
    napi_throw_type_error(env, NULL, "Expected a resource ID");
    return NULL;
  }
  WCHAR text[LOAD_STRING_MAX_LENGTH];
  int length = 0;
  HMODULE module = LoadLibraryExW(path, NULL, LOAD_LIBRARY_AS_DATAFILE);
  FreeWide(path);
  if (module != NULL) {
    length = LoadStringW(module, (UINT) resourceId, text, LOAD_STRING_MAX_LENGTH);
    FreeLibrary(module);
  }
  return WideString(env, text, length > 0 ? (size_t) length : 0);
}

NAPI_MODULE_INIT(/* napi_env env, napi_value exports */) {
  napi_property_descriptor properties[] = {
    { "GetDynamicTimeZoneInformation", NULL, GetDynamicTimeZoneInformationJs, NULL, NULL, NULL, napi_enumerable, NULL },
    { "GetRegistrySubKeyNames", NULL, GetRegistrySubKeyNamesJs, NULL, NULL, NULL, napi_enumerable, NULL },
    { "RegistryKeyExists", NULL, RegistryKeyExistsJs, NULL, NULL, NULL, napi_enumerable, NULL },
    { "GetRegistryValue", NULL, GetRegistryValueJs, NULL, NULL, NULL, napi_enumerable, NULL },
    { "GetSystemDirectory", NULL, GetSystemDirectoryJs, NULL, NULL, NULL, napi_enumerable, NULL },
    { "GetUserPreferredUILanguages", NULL, GetUserPreferredUILanguagesJs, NULL, NULL, NULL, napi_enumerable, NULL },
    { "FileExists", NULL, FileExistsJs, NULL, NULL, NULL, napi_enumerable, NULL },
    { "LoadString", NULL, LoadStringJs, NULL, NULL, NULL, napi_enumerable, NULL },
  };
  if (napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) != napi_ok) {
    return NULL;
  }
  return exports;
}
