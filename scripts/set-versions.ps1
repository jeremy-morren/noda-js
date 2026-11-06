#requires -Version 7.4
<#
.SYNOPSIS
  Sets the packages' versions for a release.
.DESCRIPTION
  In the repo the packages' versions are the placeholder 0.0.0-development (as is noda-js-zod's peer dependency on
  noda-js, so npm links the workspace); this sets them to the release's version, and the peer dependency to
  ^version. The Windows native addon packages (src/noda-js-win32-x64, src/noda-js-win32-arm64; not workspaces) get the
  same version, and noda-js lists them as optionalDependencies at exactly that version (only for releases: in the repo,
  npm would otherwise look for them on the registry). npm pkg set keeps package.json's formatting. The release workflows run it on their checkout; locally,
  discard the change afterwards.
  Usage: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/set-versions.ps1 -Version 0.2.0
#>
param(
  [Parameter(Mandatory)] [string] $Version
)
. (Join-Path $PSScriptRoot ci-helpers.ps1)

if ($Version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$')
{
  Stop-WithError "Release versions are MAJOR.MINOR.PATCH, not '$Version'."
}
Push-Location $repo
try {
  npm pkg set "version=$Version" --workspace src/noda-js --workspace src/noda-js-zod
  npm pkg set "peerDependencies.noda-js=^$Version" --workspace src/noda-js-zod
  foreach ($native in $NativePackages)
  {
    npm pkg set "version=$Version" --prefix (Join-Path $repo "src/$native")
    npm pkg set "optionalDependencies.$native=$Version" --workspace src/noda-js
  }
  Write-Host "noda-js, noda-js-zod and $($NativePackages -join ', ') are $Version (noda-js-zod's peer dependency: noda-js ^$Version; noda-js's optional dependencies: the native packages, $Version)."
} finally {
  Pop-Location
}
