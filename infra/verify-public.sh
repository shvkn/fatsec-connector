#!/usr/bin/env bash
set -euo pipefail

PUBLIC_URL="${1:-${PUBLIC_URL:-}}"
if [[ -z "${PUBLIC_URL}" ]]; then
  echo "Usage: $0 https://your-container-url" >&2
  exit 1
fi
PUBLIC_URL="${PUBLIC_URL%/}"
CURL=(curl --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 10 --max-time 30)

"${CURL[@]}" --fail --silent --show-error "${PUBLIC_URL}/health" >/dev/null
"${CURL[@]}" --fail --silent --show-error "${PUBLIC_URL}/openapi.json" >/dev/null
"${CURL[@]}" --fail --silent --show-error "${PUBLIC_URL}/.well-known/ai-plugin.json" >/dev/null

status="$("${CURL[@]}" --silent --output /dev/null --write-out '%{http_code}' \
  "${PUBLIC_URL}/v1/foods/search?query=test")"
if [[ "${status}" != "401" ]]; then
  echo "Expected protected API to return 401 without a key, got ${status}" >&2
  exit 1
fi

echo "Public verification passed: health/schema/manifest are reachable; API requires authentication."
