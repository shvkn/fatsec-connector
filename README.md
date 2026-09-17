# FatSecret Food Diary Connector

Персональный Node.js-коннектор для сценария **ChatGPT → Yandex Cloud → FatSecret Food Diary**. Он сохраняет OAuth 1.0 access token личного FatSecret-аккаунта в YDB в зашифрованном виде, даёт ChatGPT безопасный API для поиска продуктов и записывает только уже выбранные порции.

## Возможности

- FatSecret OAuth 1.0a 3-legged authorization для существующего аккаунта;
- админ-панель для подключения, обновления и отключения аккаунта;
- AES-256-GCM шифрование OAuth access token и token secret в YDB;
- `GET /health` — публичная проверка сервиса и YDB;
- поиск продуктов и получение доступных порций;
- чтение дневника за дату;
- пакетная запись до 20 ингредиентов в один приём пищи;
- отдельный `API_KEY` для ChatGPT API (заголовок `X-API-Key` или Bearer token);
- OpenAPI 3.1 и legacy plugin manifest;
- Docker, тесты и деплой в Yandex Serverless Containers с Lockbox.

Consumer Secret, access token secrets, ключ шифрования, пароль и API key никогда не должны попадать в git. `.env` исключён через `.gitignore`; в production все значения передаются из Yandex Lockbox.

## API для ChatGPT

Публичные endpoints:

- `GET /health`;
- `GET /openapi.json`;
- `GET /.well-known/ai-plugin.json`.

Endpoints с `X-API-Key: <API_KEY>` или `Authorization: Bearer <API_KEY>`:

- `GET /v1/foods/search?query=...&maxResults=10`;
- `GET /v1/foods/:foodId` — детали и порции; порции с `canLog: false` нельзя записывать;
- `GET /v1/diary?date=YYYY-MM-DD`;
- `POST /v1/diary/entries` — запись нескольких подтверждённых позиций.

Пример тела записи:

```json
{
  "date": "2026-09-17",
  "meal": "dinner",
  "items": [
    {
      "foodId": "1641",
      "servingId": "50321",
      "numberOfUnits": 250,
      "name": "Chicken breast"
    }
  ]
}
```

`numberOfUnits` — именно количество единиц выбранной порции FatSecret. Например, если выбранная порция — `100 g` с `number_of_units=100`, то для 250 г используется `250`. Сначала нужно вызвать поиск и получить детали продукта, затем показать пользователю выбранные продукты/порции и только после подтверждения вызвать write endpoint.

FatSecret не предоставляет атомарный batch-вызов. Коннектор валидирует весь запрос до первой записи и пишет позиции последовательно; при внешней ошибке ответ `502` содержит `failedItemIndex` и уже созданные записи.

## Локальный запуск

Нужны Node.js 22+, pnpm 11 и Docker.

1. Создайте FatSecret OAuth 1.0 приложение в [FatSecret Platform](https://platform.fatsecret.com/api/) и получите Consumer Key и Shared Secret.
2. Подготовьте локальные настройки:

   ```bash
   cp .env.example .env
   openssl rand -base64 32
   openssl rand -base64 32
   openssl rand -base64 32
   ```

3. Укажите первые два случайных значения как `TOKEN_ENCRYPTION_KEY` и `SESSION_SECRET`, третье — как `API_KEY`; добавьте ключи FatSecret и задайте сильный `ADMIN_PASSWORD`.
4. В настройках FatSecret укажите callback URL `http://localhost:8080/auth/callback`.
5. Запустите:

   ```bash
   docker compose up --build
   ```

6. Откройте `http://localhost:8080`, войдите с `ADMIN_PASSWORD`, нажмите «Подключить аккаунт» и подтвердите доступ на FatSecret.

Проверки без Docker:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
docker build -t fatsecret-diary-connector:test .
```

## Existing Yandex Cloud endpoint

Production URL этого проекта:

`https://bba2kmapkmq3elov3hot.containers.yandexcloud.net`

Точный FatSecret callback URL:

`https://bba2kmapkmq3elov3hot.containers.yandexcloud.net/auth/callback`

В существующем Lockbox должны быть ключи:

- `FATSECRET_CONSUMER_KEY`;
- `FATSECRET_CONSUMER_SECRET`;
- `TOKEN_ENCRYPTION_KEY`;
- `SESSION_SECRET`;
- `ADMIN_PASSWORD`;
- `API_KEY`.

Если первые пять уже существуют, добавьте только новый случайный `API_KEY` через Yandex Cloud Console или безопасный локальный способ, не передавая значение в чат и не коммитя его.

Сервисному аккаунту контейнера нужны роли `ydb.editor`, `container-registry.images.puller` и `lockbox.payloadViewer`; для KMS-шифрованного секрета также нужна `kms.keys.encrypterDecrypter`.

Ручной деплой в уже созданные ресурсы:

```bash
export YC_FOLDER_ID=...
export YC_REGISTRY_ID=...
export YC_CONTAINER_ID=...
export YC_SERVICE_ACCOUNT_ID=...
export YC_LOCKBOX_SECRET_ID=...
export YDB_CONNECTION_STRING='grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/...'
export YC_CONTAINER_NAME=fatsecret-diary-connector
export PUBLIC_URL='https://bba2kmapkmq3elov3hot.containers.yandexcloud.net'
bash infra/deploy-yandex.sh
bash infra/verify-public.sh "$PUBLIC_URL"
```

Скрипт собирает `linux/amd64` образ, отправляет его в Container Registry, создаёт ревизию, привязывает только ссылки на значения Lockbox и оставляет публичный invoke включённым. Сам API записи остаётся закрыт `API_KEY`.

После деплоя проверьте, что callback URL приложения FatSecret в точности совпадает с production URL выше. Затем откройте production-панель, войдите и подключите личный аккаунт. OAuth-токены будут сохранены в YDB, а не в переменных окружения и не в git.

## Подключение к ChatGPT

1. В ChatGPT Action/интеграции импортируйте `https://bba2kmapkmq3elov3hot.containers.yandexcloud.net/openapi.json`.
2. Выберите API key authentication, header name `X-API-Key`, и внесите production `API_KEY` как секрет интеграции.
3. Разрешайте write action только после подтверждения пользователем конкретных продуктов, порций и количеств.

OpenAPI также допускает Bearer auth для клиентов, которые не умеют задавать собственное имя заголовка.

## GitHub Actions

Workflow `CI` запускает синтаксические проверки, тесты и Docker build. Workflow `Deploy to Yandex Cloud` запускается вручную.

В GitHub Environment `production` нужны:

- secret `YC_SA_JSON_CREDENTIALS`;
- variables `YC_FOLDER_ID`, `YC_REGISTRY_ID`, `YC_CONTAINER_ID`, `YC_SERVICE_ACCOUNT_ID`, `YC_LOCKBOX_SECRET_ID`, `YDB_CONNECTION_STRING`, `PUBLIC_URL`.

Секреты FatSecret и `API_KEY` в GitHub добавлять не нужно: ревизия получает их напрямую из Lockbox.

Официальная документация: [FatSecret 3-Legged OAuth](https://platform.fatsecret.com/docs/guides/authentication/oauth1/three-legged), [Create Food Diary Entry](https://platform.fatsecret.com/docs/v1/food_entry.create), [YDB Serverless](https://yandex.cloud/ru/docs/ydb/concepts/serverless-and-dedicated), [Yandex Serverless Containers](https://yandex.cloud/en/docs/serverless-containers/).
