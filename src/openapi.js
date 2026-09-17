export function openApiDocument(publicUrl) {
  return {
    openapi: "3.1.0",
    info: {
      title: "FatSecret Food Diary Connector",
      version: "1.1.0",
      description: "Search FatSecret foods and add confirmed items to a connected user's food diary. Search first, inspect servings, then create diary entries."
    },
    servers: [{ url: publicUrl }],
    paths: {
      "/health": {
        get: {
          operationId: "healthCheck",
          summary: "Check connector and database health",
          security: [],
          responses: { "200": { description: "Healthy" } }
        }
      },
      "/v1/foods/search": {
        get: {
          operationId: "searchFoods",
          summary: "Search foods for the connected FatSecret account",
          parameters: [
            { name: "query", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 200 } },
            { name: "maxResults", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
            { name: "page", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "accountId", in: "query", schema: { type: "string", format: "uuid" } }
          ],
          responses: {
            "200": { description: "Matching foods" },
            "401": { description: "Invalid API key" },
            "409": { description: "No FatSecret account is connected" }
          }
        }
      },
      "/v1/foods/{foodId}": {
        get: {
          operationId: "getFoodServings",
          summary: "Get a food and its available servings",
          description: "Choose a serving whose canLog value is true before creating a diary entry.",
          parameters: [
            { name: "foodId", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+$" } },
            { name: "accountId", in: "query", schema: { type: "string", format: "uuid" } }
          ],
          responses: { "200": { description: "Food details and servings" }, "401": { description: "Invalid API key" } }
        }
      },
      "/v1/diary": {
        get: {
          operationId: "getDiary",
          summary: "Get diary entries for a date",
          parameters: [
            { name: "date", in: "query", schema: { type: "string", format: "date", description: "Defaults to today (UTC)." } },
            { name: "accountId", in: "query", schema: { type: "string", format: "uuid" } }
          ],
          responses: { "200": { description: "Diary entries and macro totals" }, "401": { description: "Invalid API key" } }
        }
      },
      "/v1/diary/entries": {
        post: {
          operationId: "createDiaryEntries",
          summary: "Add one or more confirmed food servings to the diary",
          description: "This operation writes to FatSecret. Ask the user to confirm ambiguous foods and serving quantities before calling it. All items are validated before the first write, but FatSecret does not provide an atomic batch operation.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateDiaryEntriesRequest" },
                examples: {
                  dinner: {
                    value: {
                      date: "2026-09-17",
                      meal: "dinner",
                      items: [
                        { foodId: "1641", servingId: "50321", numberOfUnits: 250, name: "Chicken breast" }
                      ]
                    }
                  }
                }
              }
            }
          },
          responses: {
            "201": { description: "All entries created" },
            "400": { description: "Invalid request; nothing was written" },
            "401": { description: "Invalid API key" },
            "409": { description: "No FatSecret account is connected" },
            "502": { description: "FatSecret failed after zero or more entries; response includes created entries" }
          }
        }
      }
    },
    components: {
      securitySchemes: {
        ApiKey: { type: "apiKey", in: "header", name: "X-API-Key", description: "Connector API key stored as a secret in ChatGPT and Yandex Lockbox." },
        BearerAuth: { type: "http", scheme: "bearer" }
      },
      schemas: {
        DiaryItem: {
          type: "object",
          additionalProperties: false,
          required: ["foodId", "servingId", "numberOfUnits", "name"],
          properties: {
            foodId: { type: "string", pattern: "^[0-9]+$" },
            servingId: { type: "string", pattern: "^[1-9][0-9]*$", description: "Serving ID 0 is derived and cannot be logged." },
            numberOfUnits: { type: "number", exclusiveMinimum: 0, maximum: 10000 },
            name: { type: "string", minLength: 1, maxLength: 200 }
          }
        },
        CreateDiaryEntriesRequest: {
          type: "object",
          additionalProperties: false,
          required: ["meal", "items"],
          properties: {
            accountId: { type: "string", format: "uuid", description: "Omit when only one account is connected." },
            date: { type: "string", format: "date", description: "Defaults to today (UTC)." },
            meal: { type: "string", enum: ["breakfast", "lunch", "dinner", "other"] },
            items: { type: "array", minItems: 1, maxItems: 20, items: { $ref: "#/components/schemas/DiaryItem" } }
          }
        }
      }
    },
    security: [{ ApiKey: [] }, { BearerAuth: [] }]
  };
}

export function pluginManifest(publicUrl) {
  return {
    schema_version: "v1",
    name_for_human: "FatSecret Diary",
    name_for_model: "fatsecret_diary",
    description_for_human: "Search foods and add confirmed entries to your FatSecret diary.",
    description_for_model: "Search FatSecret foods, inspect exact servings, and add entries only after the user confirms ambiguous choices.",
    auth: { type: "service_http", authorization_type: "bearer" },
    api: { type: "openapi", url: `${publicUrl}/openapi.json` },
    logo_url: `${publicUrl}/logo.svg`,
    contact_email: "support@example.invalid",
    legal_info_url: `${publicUrl}/`
  };
}
