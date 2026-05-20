#!/usr/bin/env bash
# Seed booking requests for test100.getbookking.com (override with extra args).
set -e
cd "$(dirname "$0")/.."
node scripts/seed-booking-requests.js --slug=test100 --count="${1:-100}" "${@:2}"
