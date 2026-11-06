#!/usr/bin/env bash
# Lets the runner's user use KVM (Linux GitHub runners), so the Android emulator runs with hardware acceleration.
# The udev rule from reactivecircus/android-emulator-runner's README. Needs sudo. Linux only.
# Usage: bash scripts/enable-kvm.sh
set -euo pipefail

echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules > /dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm
