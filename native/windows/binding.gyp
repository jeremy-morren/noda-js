{
  # noda-js: the native addon for noda-js-win32-x64 and noda-js-win32-arm64 (built by scripts/build-native.ps1).
  # A plain C Node-API module; the flags make the build reproducible (no timestamps, no debug info, fixed paths).
  "targets": [
    {
      "target_name": "time-zones",
      "sources": ["time-zones.c"],
      "defines": ["NAPI_VERSION=8"],
      "libraries": ["advapi32.lib", "user32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/Brepro", "/utf-8", "/W4", "/WX"],
          "DebugInformationFormat": "0",
        },
        "VCLinkerTool": {
          "AdditionalOptions": ["/Brepro", "/DEBUG:NONE"],
          "GenerateDebugInformation": "false",
        },
      },
    },
  ],
}
