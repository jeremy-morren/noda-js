#!/usr/bin/env bash
# Boots an iPhone in the iOS Simulator for the ios-safari test project (macOS with Xcode; needs jq).
#
# Picks the newest iOS runtime installed and, in it, an available iPhone (the device named by the first argument, else
# the highest-numbered "iPhone <number>", else any iPhone), boots it and waits until it's ready (safaridriver would
# boot one itself, but within its session timeout). Sets NODA_TEST_IOS_UDID (vitest.config.ts passes it to safaridriver
# as safari:deviceUDID) and NODA_TEST_LABEL ("iPhone 16 (iOS 18.5)", the test results' label) for later steps in GitHub
# Actions; prints them either way. safaridriver must be enabled once: `sudo safaridriver --enable`.
# Usage: npm run test:start-ios-simulator [-- 'iPhone 16']
set -euo pipefail

device="${1:-}"

fail() {
  echo "::error::$1" >&2
  exit 1
}

json="$(xcrun simctl list devices available --json)"

# The newest iOS runtime that has an iPhone (keys like com.apple.CoreSimulator.SimRuntime.iOS-26-5).
runtime="$(jq -r '
  .devices | to_entries
  | map(select(.key | test("\\.iOS-[0-9]+-[0-9]+(-[0-9]+)?$")))
  | map(select([.value[] | select(.name | startswith("iPhone"))] | length > 0))
  | sort_by(.key | capture("iOS-(?<major>[0-9]+)-(?<minor>[0-9]+)(-(?<patch>[0-9]+))?$")
      | [(.major | tonumber), (.minor | tonumber), ((.patch // "0") | tonumber)])
  | last | .key // empty' <<< "$json")"
[ -n "$runtime" ] || fail "No iOS Simulator runtime with an iPhone is installed (xcrun simctl list devices available)."

# The iPhone: the one named, else the highest-numbered "iPhone <number>", else the first.
iphone="$(jq -c --arg runtime "$runtime" --arg device "$device" '
  [.devices[$runtime][] | select(.name | startswith("iPhone"))] as $iphones
  | if $device != "" then ($iphones | map(select(.name == $device)) | first)
    else (($iphones | map(select(.name | test("^iPhone [0-9]+$")))
             | sort_by(.name | ltrimstr("iPhone ") | tonumber) | last) // ($iphones | first))
    end // empty' <<< "$json")"
if [ -z "$iphone" ]; then
  fail "No available '$device' in $runtime (has: $(jq -r --arg runtime "$runtime" '[.devices[$runtime][] | select(.name | startswith("iPhone")) | .name] | join(", ")' <<< "$json"))."
fi
name="$(jq -r .name <<< "$iphone")"
udid="$(jq -r .udid <<< "$iphone")"
state="$(jq -r .state <<< "$iphone")"

# "iOS-26-5" -> "26.5", "iOS-18-5-1" -> "18.5.1".
version="$(sed -E 's/.*iOS-//; s/-/./g' <<< "$runtime")"

echo "Booting $name (iOS $version), $udid"
if [ "$state" != "Booted" ]; then
  xcrun simctl boot "$udid"
fi
# Waits until the device has finished booting (SpringBoard and its services are up).
xcrun simctl bootstatus "$udid" -b

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "NODA_TEST_IOS_UDID=$udid" >> "$GITHUB_ENV"
  echo "NODA_TEST_LABEL=$name (iOS $version)" >> "$GITHUB_ENV"
fi
echo "NODA_TEST_IOS_UDID=$udid"
echo "NODA_TEST_LABEL=$name (iOS $version)"
