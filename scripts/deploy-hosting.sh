#!/usr/bin/env bash
# Deploy both Firebase Hosting sites (requires firebase-tools, logged in).
# Booking (test-app-96812): tenant subdomains *.getbookking.com + web.app
# Marketing (test-app-96812-marketing): getbookking.com landing + signup
set -e
cd "$(dirname "$0")/.."
firebase deploy --only hosting:booking,hosting:marketing "$@"
