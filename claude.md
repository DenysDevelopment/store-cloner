# Shopify Migration Tool

## Project Overview

CLI-инструмент для полной миграции данных между Shopify-магазинами. Экспортирует все ресурсы из магазина-источника, сохраняет в JSON, затем импортирует в целевой магазин с маппингом ID.

**Стек:** Node.js (ES modules), Commander.js, Shopify Admin API (REST + GraphQL), node-fetch, p-queue.

## Architecture

```
src/
├── index.js              # CLI точка входа (Commander.js)
├── config.js             # Конфигурация из .env, валидация, OAuth
├── api-client.js         # Единый API-клиент (REST + GraphQL + rate limiting + retry)
├── id-mapper.js          # Маппинг sourceId → targetId между магазинами
├── logger.js             # Логгер с уровнями, счётчиками и цветным выводом
└── modules/              # 14 модулей миграции
    ├── utils.js          # saveData, loadData, extractId, buildGid, sleep
    ├── theme.js          # Тема (sections, templates, assets, locales, snippets)
    ├── products.js       # (отключён — не используется в миграции)
    ├── collections.js    # Smart и custom коллекции
    ├── pages.js          # Статические страницы
    ├── blogs.js          # Блоги и статьи
    ├── menus.js          # Навигационные меню (с ремаппингом ресурсных ID)
    ├── metafields.js     # Определения метаполей и значения
    ├── metaobjects.js    # Определения метаобъектов и записи
    ├── customers.js      # Клиенты с адресами и метаполями
    ├── files.js          # Медиафайлы (изображения, видео)
    ├── redirects.js      # URL-редиректы
    ├── discounts.js      # Правила цен и промокоды
    ├── shop-settings.js  # Настройки магазина: политики, локали, markets, валюты, script tags
    └── translations.js   # Переводы всех ресурсов (18 типов, последний модуль)
```

## Key Concepts

### Module Pattern

Каждый модуль экспортирует ровно две функции:
- `export[Module](sourceClient, logger)` — получает данные из source-магазина и сохраняет в `data/{module}/data.json`
- `import[Module](targetClient, idMapper, logger, dryRun)` — загружает данные из JSON, создаёт в target-магазине, маппит ID

### Migration Order (dependency-based)

1. Theme → 2. Collections → 3. Pages → 4. Blogs → 5. Menus → 6. Metafields → 7. Metaobjects → 8. Customers → 9. Files → 10. Redirects → 11. Discounts → 12. Shop Settings → 13. Translations

Products исключены из миграции (переносятся вручную или через Shopify CSV).
Translations выполняется последним, т.к. зависит от существования всех ресурсов в целевом магазине.

### ID Mapping System

`IdMapper` — центральная сущность, отвечающая за маппинг ID между магазинами:
- `set(resourceType, sourceId, targetId)` — сохранить маппинг
- `get(resourceType, sourceId)` — получить target ID по source ID
- `setHandleMap()` / `getByHandle()` — альтернативный поиск по handle (slug)
- Персистируется в `data/id-mapping.json` после каждого модуля
- Поддерживает resume (загрузка из предыдущего запуска)

### API Client

`ApiClient` — единый клиент для обоих API:
- **GraphQL**: `graphql(query, variables)`, `graphqlAll(query, variables, connectionPath, nodeTransform)` (с пагинацией)
- **REST**: `rest(method, endpoint, body)`, `restGetAll(endpoint, resourceKey)` (с пагинацией по Link header)
- Rate limiting через `p-queue` (настраивается через `RATE_LIMIT`)
- Retry logic: 3 попытки с exponential backoff
- Обработка 429 (Retry-After) и GraphQL throttling

### Data Persistence

- Экспортированные данные: `data/{module-name}/data.json`
- Тема: `data/theme/` — зеркалирует структуру каталогов Shopify (sections, templates, snippets, locales, assets)
- ID маппинг: `data/id-mapping.json`

## CLI Commands

```bash
# Экспорт из магазина-источника
node src/index.js export [--only modules] [--exclude modules]

# Импорт в целевой магазин
node src/index.js import [--only modules] [--exclude modules] [--dry-run] [--resume]

# Полная миграция (export + import)
node src/index.js migrate [--only modules] [--exclude modules] [--dry-run]

# Верификация (сравнение count ресурсов)
node src/index.js verify

# Список доступных модулей
node src/index.js list
```

## Configuration

Через `.env` файл (см. `.env.example`):

| Переменная | Обязательная | Описание |
|---|---|---|
| `SOURCE_SHOP` | Да | Домен источника (*.myshopify.com) |
| `SOURCE_ACCESS_TOKEN` | Да* | Access token источника |
| `SOURCE_CLIENT_ID` + `SOURCE_CLIENT_SECRET` | Да* | Альтернатива: Client Credentials |
| `TARGET_SHOP` | Да | Домен целевого магазина |
| `TARGET_ACCESS_TOKEN` | Да* | Access token целевого |
| `TARGET_CLIENT_ID` + `TARGET_CLIENT_SECRET` | Да* | Альтернатива: Client Credentials |
| `API_VERSION` | Нет | Версия API (default: `2025-01`) |
| `DATA_DIR` | Нет | Директория данных (default: `./data`) |
| `RATE_LIMIT` | Нет | Запросов в секунду (default: `2`) |
| `LOG_LEVEL` | Нет | debug/info/warn/error (default: `info`) |

*Нужен либо Access Token, либо Client ID + Client Secret.

## Code Conventions

- **ES Modules** (`import`/`export`) — project type: `module`
- **Async/await** повсюду, без callback-стиля
- **Имена файлов**: kebab-case (`api-client.js`, `shop-settings.js`)
- **Функции**: camelCase (`exportProducts`, `importCollections`)
- **Классы**: PascalCase (`ApiClient`, `Logger`, `IdMapper`)
- **Константы**: UPPER_SNAKE_CASE (`RESOURCE_TYPES`, `OWNER_TYPES`)
- **Секции в коде**: разделители `// ─── Section Name ───`
- **GraphQL** для сложных запросов с пагинацией (products, collections, menus, metaobjects, translations, files)
- **REST** для простых CRUD операций (pages, blogs, customers, redirects, discounts)
- **Отступы**: 4 пробела
- **Импорты**: относительные (`'./utils.js'`, `'../config.js'`)
- **Default exports** для классов, **named exports** для функций модулей

## Error Handling

- Retry logic: 3 попытки с exponential backoff в `ApiClient`
- Rate limiting: автоматическая обработка 429 и GraphQL Throttled
- Graceful degradation: ошибки логируются, миграция продолжается
- Уже существующие ресурсы (duplicates): пропускаются с info-логом
- 404 на REST: возвращает `null` (не бросает ошибку)
- ID mapping сохраняется после каждого модуля — позволяет resume при сбое

## What IS NOT Migrated

- **Продукты** (отключены — используйте Shopify CSV или Matrixify)
- Пароли клиентов
- История заказов
- Платёжные настройки
- Настройки доставки (тарифы)
- Налоги
- Домены (привязка)
- Сторонние приложения
- Настройки checkout (частично — данные экспортируются для справки)

## Dependencies

| Пакет | Версия | Назначение |
|---|---|---|
| `commander` | ^12.1.0 | CLI-фреймворк |
| `node-fetch` | ^3.3.2 | HTTP-клиент |
| `p-queue` | ^8.0.1 | Rate-limited очередь |
| `dotenv` | ^16.4.5 | Загрузка .env |
| `chalk` | ^5.3.0 | Цветной вывод в терминале |
| `ora` | ^8.0.1 | Спиннеры для CLI |

## Development Notes

- Тестов нет — при добавлении рекомендуется покрывать `utils.js` (extractId, buildGid) и мокировать API-клиент
- `data/` папка в `.gitignore` — содержит экспортированные данные и маппинги
- `.env` в `.gitignore` — содержит токены доступа
- Для добавления нового модуля: создать `src/modules/new-module.js`, экспортировать `exportNewModule` и `importNewModule`, зарегистрировать в массиве `MODULES` в `src/index.js` в правильном порядке зависимостей
