# FatSecret Account Hub

Небольшая защищённая панель для подключения существующих аккаунтов FatSecret через OAuth 1.0a. Приложение показывает данные профиля и сводку дневника питания за текущий день, умеет обновлять и отключать аккаунты.

## Что уже реализовано

- OAuth 1.0a (трёхсторонняя авторизация FatSecret);
- защищённая паролем панель управления;
- шифрование OAuth-токенов AES-256-GCM;
- защита cookie и изменяющих запросов CSRF-токеном;
- YDB Serverless для недорогого постоянного хранения;
- Docker и локальный Docker Compose;
- GitHub Actions для проверки и деплоя;
- деплой в Yandex Serverless Containers с секретами из Lockbox.

## Локальный запуск

1. Создайте приложение в [FatSecret Platform](https://platform.fatsecret.com/api/) и получите OAuth 1.0 Consumer Key и Shared Secret.
2. Скопируйте настройки:

   ```bash
   cp .env.example .env
   openssl rand -base64 32
   openssl rand -base64 32
   ```

3. Вставьте два сгенерированных значения в `TOKEN_ENCRYPTION_KEY` и `SESSION_SECRET`, добавьте ключи FatSecret и задайте `ADMIN_PASSWORD`.
4. Запустите приложение:

   ```bash
   docker compose up --build
   ```

5. Откройте `http://localhost:8080`.

Callback URL приложения FatSecret должен совпадать с `PUBLIC_URL` и иметь путь `/api/fatsecret/callback`, например `http://localhost:8080/api/fatsecret/callback`.

## Yandex Cloud

Схема production: Serverless Containers + Container Registry + Lockbox + YDB Serverless. Приложение подключается к YDB через IAM-токен сервисного аккаунта и автоматически создаёт таблицы при старте. Для небольшой нагрузки действует бесплатный пакет YDB Serverless.

Создайте секрет Lockbox с ключами:

- `FATSECRET_CONSUMER_KEY`;
- `FATSECRET_CONSUMER_SECRET`;
- `TOKEN_ENCRYPTION_KEY`;
- `SESSION_SECRET`;
- `ADMIN_PASSWORD`.

Сервисному аккаунту контейнера нужны роли `ydb.editor`, `container-registry.images.puller` и `lockbox.payloadViewer`; для зашифрованного KMS-секрета также нужна `kms.keys.encrypterDecrypter`. Аккаунту CI нужны права на push в Container Registry и создание ревизий Serverless Containers.

Ручной деплой выполняется так:

```bash
export YC_FOLDER_ID=...
export YC_REGISTRY_ID=...
export YC_SERVICE_ACCOUNT_ID=...
export YC_LOCKBOX_SECRET_ID=...
export YDB_CONNECTION_STRING='grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/...'
export YC_CONTAINER_NAME=fatsecret-account-hub
export PUBLIC_URL=https://your-container-url.example
bash infra/deploy-yandex.sh
```

После первого деплоя обновите `PUBLIC_URL` на фактический HTTPS URL контейнера и добавьте точный callback URL в настройках FatSecret.

## GitHub Actions

В GitHub Environment `production` добавьте:

- secret `YC_SA_JSON_CREDENTIALS` — JSON-ключ сервисного аккаунта CI;
- variables `YC_FOLDER_ID`, `YC_REGISTRY_ID`, `YC_SERVICE_ACCOUNT_ID`, `YC_LOCKBOX_SECRET_ID`, `YDB_CONNECTION_STRING`, `YC_CONTAINER_NAME`, `PUBLIC_URL`.

Workflow `CI` запускает проверки и сборку Docker-образа. Workflow `Deploy to Yandex Cloud` запускается вручную, собирает образ, отправляет его в Yandex Container Registry и создаёт новую ревизию Serverless Container.

## API

- `GET /health` — проверка сервиса и базы данных;
- `POST /api/login`, `POST /api/logout` — доступ к панели;
- `GET /api/accounts` — список аккаунтов без выдачи токенов;
- `POST /api/fatsecret/connect` — начало OAuth-подключения;
- `GET /api/fatsecret/callback` — OAuth callback;
- `POST /api/accounts/:id/sync` — обновить профиль и дневник;
- `DELETE /api/accounts/:id` — отключить аккаунт.

Официальная документация: [FatSecret 3-Legged OAuth](https://platform.fatsecret.com/docs/guides/authentication/oauth1/three-legged), [YDB Serverless](https://yandex.cloud/ru/docs/ydb/concepts/serverless-and-dedicated), [Yandex Serverless Containers](https://yandex.cloud/en/docs/serverless-containers/), [передача Lockbox-секретов](https://yandex.cloud/en/docs/lockbox/operations/serverless/containers).
