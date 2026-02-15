# 🛒 Shopify Store Migration Tool

Полная миграция Shopify магазина на другой аккаунт, включая:
- ✅ **Товары** (с вариантами, изображениями, метаполями)
- ✅ **Коллекции** (smart + custom)
- ✅ **Страницы и блоги** (с статьями)
- ✅ **Навигация** (меню)
- ✅ **Метаполя** (определения + значения)
- ✅ **Метаобъекты** (определения + записи)
- ✅ **Переводы** (с ремаппингом ID!)
- ✅ **Тема** (все файлы: sections, templates, snippets, locales, assets)
- ✅ **Клиенты** (с адресами)
- ✅ **URL-редиректы**
- ✅ **Файлы** (изображения, видео)
- ✅ **Скидки** (price rules + коды)
- ✅ **Настройки магазина**

## Установка

```bash
npm install
cp .env.example .env
# Заполните .env вашими данными
```

## Настройка .env

```env
SOURCE_SHOP=source-store.myshopify.com
SOURCE_ACCESS_TOKEN=shpat_xxx

TARGET_SHOP=target-store.myshopify.com
TARGET_ACCESS_TOKEN=shpat_xxx

API_VERSION=2025-01
```

### Как получить Access Token:
1. В Shopify Admin → Settings → Apps and sales channels
2. Develop apps → Create an app
3. Configure Admin API scopes — включите **все** scopes (read/write)
4. Install app → получите Admin API access token

## Использование

### Полная миграция (экспорт + импорт):
```bash
node src/index.js migrate
```

### Только экспорт:
```bash
node src/index.js export
```

### Только импорт:
```bash
node src/index.js import
```

### Пробный запуск (без изменений):
```bash
node src/index.js migrate --dry-run
```

### Конкретные модули:
```bash
# Только товары и коллекции
node src/index.js migrate --only products,collections

# Всё кроме клиентов
node src/index.js migrate --exclude customers

# Только тему и переводы
node src/index.js migrate --only theme,translations
```

### Проверка после миграции:
```bash
node src/index.js verify
```

### Возобновление (если прервалось):
```bash
node src/index.js import --resume
```

## Порядок миграции

Скрипт автоматически выполняет импорт в правильном порядке:

1. **Тема** (sections, templates, assets)
2. **Товары** (с вариантами и изображениями)
3. **Коллекции** (smart + custom с привязкой товаров)
4. **Страницы**
5. **Блоги и статьи**
6. **Меню** (с ремаппингом ссылок)
7. **Метаполя** (определения)
8. **Метаобъекты**
9. **Клиенты**
10. **Файлы**
11. **Редиректы**
12. **Скидки**
13. **Настройки**
14. **Переводы** (последними, когда все ресурсы уже созданы)

## ⚠️ Что НЕ переносится автоматически

- Пароли клиентов (Shopify не позволяет)
- История заказов
- Настройки платежей
- Настройки доставки
- Налоги
- Домен (нужно перенастроить DNS)
- Приложения (нужно переустановить)
