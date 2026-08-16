#!/usr/bin/env bash
set -euo pipefail

required=(YC_FOLDER_ID YC_REGISTRY_ID YC_SERVICE_ACCOUNT_ID YC_LOCKBOX_SECRET_ID YC_NETWORK_ID PUBLIC_URL)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Required environment variable is missing: ${name}" >&2
    exit 1
  fi
done

IMAGE="cr.yandex/${YC_REGISTRY_ID}/fatsecret-account-hub:${IMAGE_TAG:-latest}"
CONTAINER_NAME="${YC_CONTAINER_NAME:-fatsecret-account-hub}"

yc config set folder-id "${YC_FOLDER_ID}"
yc container registry configure-docker
docker build --platform linux/amd64 -t "${IMAGE}" .
docker push "${IMAGE}"

if ! yc serverless container get --name "${CONTAINER_NAME}" >/dev/null 2>&1; then
  yc serverless container create --name "${CONTAINER_NAME}"
fi

yc serverless container revision deploy \
  --container-name "${CONTAINER_NAME}" \
  --image "${IMAGE}" \
  --cores 1 \
  --memory 512MB \
  --execution-timeout 30s \
  --concurrency 8 \
  --service-account-id "${YC_SERVICE_ACCOUNT_ID}" \
  --network-id "${YC_NETWORK_ID}" \
  --environment "NODE_ENV=production,PUBLIC_URL=${PUBLIC_URL},DATABASE_SSL=true" \
  --secret "environment-variable=DATABASE_URL,id=${YC_LOCKBOX_SECRET_ID},key=DATABASE_URL" \
  --secret "environment-variable=DATABASE_CA_CERT,id=${YC_LOCKBOX_SECRET_ID},key=DATABASE_CA_CERT" \
  --secret "environment-variable=FATSECRET_CONSUMER_KEY,id=${YC_LOCKBOX_SECRET_ID},key=FATSECRET_CONSUMER_KEY" \
  --secret "environment-variable=FATSECRET_CONSUMER_SECRET,id=${YC_LOCKBOX_SECRET_ID},key=FATSECRET_CONSUMER_SECRET" \
  --secret "environment-variable=TOKEN_ENCRYPTION_KEY,id=${YC_LOCKBOX_SECRET_ID},key=TOKEN_ENCRYPTION_KEY" \
  --secret "environment-variable=SESSION_SECRET,id=${YC_LOCKBOX_SECRET_ID},key=SESSION_SECRET" \
  --secret "environment-variable=ADMIN_PASSWORD,id=${YC_LOCKBOX_SECRET_ID},key=ADMIN_PASSWORD"

yc serverless container allow-unauthenticated-invoke "${CONTAINER_NAME}"
yc serverless container get --name "${CONTAINER_NAME}" --format json --jq '.url'
