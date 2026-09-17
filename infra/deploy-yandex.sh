#!/usr/bin/env bash
set -euo pipefail

required=(YC_FOLDER_ID YC_REGISTRY_ID YC_CONTAINER_ID YC_SERVICE_ACCOUNT_ID YC_LOCKBOX_SECRET_ID YDB_CONNECTION_STRING PUBLIC_URL)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Required environment variable is missing: ${name}" >&2
    exit 1
  fi
done

IMAGE="cr.yandex/${YC_REGISTRY_ID}/fatsecret-account-hub:${IMAGE_TAG:-latest}"

yc config set folder-id "${YC_FOLDER_ID}"
yc container registry configure-docker
docker build --platform linux/amd64 -t "${IMAGE}" .
docker push "${IMAGE}"

yc serverless container revision deploy \
  --container-id "${YC_CONTAINER_ID}" \
  --image "${IMAGE}" \
  --cores 1 \
  --memory 512MB \
  --execution-timeout 30s \
  --concurrency 8 \
  --service-account-id "${YC_SERVICE_ACCOUNT_ID}" \
  --environment "NODE_ENV=production,PUBLIC_URL=${PUBLIC_URL},YDB_CONNECTION_STRING=${YDB_CONNECTION_STRING},YDB_AUTH_MODE=metadata" \
  --secret "environment-variable=FATSECRET_CONSUMER_KEY,id=${YC_LOCKBOX_SECRET_ID},key=FATSECRET_CONSUMER_KEY" \
  --secret "environment-variable=FATSECRET_CONSUMER_SECRET,id=${YC_LOCKBOX_SECRET_ID},key=FATSECRET_CONSUMER_SECRET" \
  --secret "environment-variable=TOKEN_ENCRYPTION_KEY,id=${YC_LOCKBOX_SECRET_ID},key=TOKEN_ENCRYPTION_KEY" \
  --secret "environment-variable=SESSION_SECRET,id=${YC_LOCKBOX_SECRET_ID},key=SESSION_SECRET" \
  --secret "environment-variable=ADMIN_PASSWORD,id=${YC_LOCKBOX_SECRET_ID},key=ADMIN_PASSWORD"

yc serverless container allow-unauthenticated-invoke --id "${YC_CONTAINER_ID}"
yc serverless container get --id "${YC_CONTAINER_ID}" --format json --jq '.url'
