#!/usr/bin/env bash
# Runs the tests in Chrome on a running Android emulator or device (the android-chrome project), for CI's android job.
#
# Needs adb (one device connected), curl, and Appium with its UiAutomator2 driver on the PATH (ci.yml installs both).
# Checks that Chrome is installed, turns off its first-run screens, forwards the device's 127.0.0.1:<port> to this
# machine (adb reverse; Vitest's browser server listens there, see vitest.config.ts), starts Appium on 127.0.0.1:4723
# (it downloads the chromedriver matching the device's Chrome), and runs `npm run test:blob -- -Project android-chrome`
# (scripts/test-blob.ps1), labelled with the Android and Chrome versions. Appium's log is test-results/appium.log.
# Usage: npm run test:android [-- <port>]   (default port 23400)
set -euo pipefail

port="${1:-23400}"
cd "$(dirname "$0")/.."

fail() {
  echo "::error::$1" >&2
  exit 1
}

adb wait-for-device
if ! adb shell pm list packages com.android.chrome | tr -d '\r' | grep -qx 'package:com.android.chrome'; then
  fail 'Chrome (com.android.chrome) is not installed on the device; use a Google APIs system image.'
fi
chrome="$(adb shell dumpsys package com.android.chrome | tr -d '\r' | grep -o 'versionName=[0-9.]*' | head -n 1 | cut -d= -f2)"
android="$(adb shell getprop ro.build.version.release | tr -d '\r\n')"
label="Android $android, Chrome ${chrome%%.*}"
echo "Device: $label ($chrome)"

# Chrome reads its command line from this file when it's the debug app: no first-run experience or default-browser
# prompt covering the page.
adb shell "echo '_ --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line"
adb shell am set-debug-app --persistent com.android.chrome
adb reverse "tcp:$port" "tcp:$port"

mkdir -p test-results
appium --address 127.0.0.1 --port 4723 --allow-insecure uiautomator2:chromedriver_autodownload \
  > test-results/appium.log 2> test-results/appium-error.log &
appium_pid=$!
cleanup() {
  kill "$appium_pid" 2> /dev/null || true
  adb reverse --remove-all || true
}
trap cleanup EXIT

deadline=$((SECONDS + 120))
until curl -fsS --max-time 5 http://127.0.0.1:4723/status 2> /dev/null | grep -q '"ready": *true'; do
  if ! kill -0 "$appium_pid" 2> /dev/null; then
    fail 'Appium exited; see test-results/appium*.log.'
  fi
  if [ "$SECONDS" -gt "$deadline" ]; then
    fail 'Appium did not start within 2 minutes; see test-results/appium*.log.'
  fi
  sleep 2
done

NODA_TEST_API_PORT="$port" npm run test:blob -- -Project android-chrome -Label "$label"
