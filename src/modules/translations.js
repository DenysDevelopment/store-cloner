import { saveData, loadData, extractId, buildGid } from './utils.js';

const TRANSLATABLE_RESOURCES_QUERY = `
  query TranslatableResources($resourceType: TranslatableResourceType!, $cursor: String) {
    translatableResources(first: 50, after: $cursor, resourceType: $resourceType) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          resourceId
          translatableContent {
            key
            value
            digest
            locale
          }
        }
      }
    }
  }
`;

const TRANSLATIONS_QUERY = `
  query Translations($resourceId: ID!, $locale: String!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translations(locale: $locale) {
        key
        value
        locale
        outdated
      }
    }
  }
`;

// ─── All translatable resource types ──────────────────────
const RESOURCE_TYPES = [
    'PRODUCT',
    'PRODUCT_VARIANT',
    'COLLECTION',
    'PAGE',
    'BLOG',
    'ARTICLE',
    'LINK',
    'SHOP',
    'SHOP_POLICY',
    'METAOBJECT',
    'METAFIELD',
    'MENU',
    'ONLINE_STORE_THEME',
    'ONLINE_STORE_THEME_APP_EMBED',
    'EMAIL_TEMPLATE',
    'SMS_TEMPLATE',
    'DELIVERY_METHOD_DEFINITION',
    'PAYMENT_GATEWAY',
    'FILTER',
    'PACKING_SLIP_TEMPLATE',
];

// Map resource type to GID type and ID mapper key
const RESOURCE_MAP = {
    PRODUCT: { gidType: 'Product', mapperKey: 'products' },
    PRODUCT_VARIANT: { gidType: 'ProductVariant', mapperKey: 'variants' },
    COLLECTION: { gidType: 'Collection', mapperKey: 'collections' },
    PAGE: { gidType: 'Page', mapperKey: 'pages' },
    BLOG: { gidType: 'Blog', mapperKey: 'blogs' },
    ARTICLE: { gidType: 'Article', mapperKey: 'articles' },
    METAOBJECT: { gidType: 'Metaobject', mapperKey: 'metaobjects' },
    LINK: { gidType: 'Link', mapperKey: 'links' },
    METAFIELD: { gidType: 'Metafield', mapperKey: 'metafields' },
    MENU: { gidType: 'Menu', mapperKey: 'menus' },
};

// Resource types that can be matched by content (fallback when no ID mapping)
const MATCH_BY_CONTENT_TYPES = new Set([
    'SHOP', 'PRODUCT', 'PRODUCT_VARIANT', 'LINK', 'METAFIELD',
    'ONLINE_STORE_THEME', 'ONLINE_STORE_THEME_APP_EMBED',
    'EMAIL_TEMPLATE', 'SMS_TEMPLATE', 'DELIVERY_METHOD_DEFINITION',
    'PAYMENT_GATEWAY', 'SHOP_POLICY', 'FILTER', 'PACKING_SLIP_TEMPLATE',
]);

// ─── Export ───────────────────────────────────────────────

export async function exportTranslations(sourceClient, logger) {
    logger.section('Exporting Translations');

    // First get available locales
    const shopQuery = `{ shop { id } shopLocales { locale primary published } }`;
    const shopData = await sourceClient.graphql(shopQuery);
    const allLocales = shopData?.shopLocales || [];
    const primaryLocale = allLocales.find(l => l.primary)?.locale || 'en';
    const locales = allLocales.filter(l => !l.primary && l.published);

    if (locales.length === 0) {
        logger.info('No secondary locales found, skipping translations');
        await saveData('translations', { locales: [], primaryLocale, translations: {} });
        return {};
    }

    logger.info(`Primary locale: ${primaryLocale}`);
    logger.info(`Found ${locales.length} secondary locales: ${locales.map(l => l.locale).join(', ')}`);

    const allTranslations = {};
    let totalExported = 0;

    for (const resourceType of RESOURCE_TYPES) {
        allTranslations[resourceType] = [];

        try {
            // Get all translatable resources of this type
            const resources = await sourceClient.graphqlAll(
                TRANSLATABLE_RESOURCES_QUERY,
                { resourceType },
                'translatableResources'
            );

            if (resources.length === 0) continue;

            logger.info(`  ${resourceType}: ${resources.length} translatable resources`);

            let resourceCount = 0;

            // Get translations for each resource in each locale
            for (const resource of resources) {
                const resourceTranslations = {
                    resourceId: resource.resourceId,
                    translatableContent: resource.translatableContent,
                    translations: {},
                };

                for (const locale of locales) {
                    try {
                        const transData = await sourceClient.graphql(TRANSLATIONS_QUERY, {
                            resourceId: resource.resourceId,
                            locale: locale.locale,
                        });

                        const translations = transData?.translatableResource?.translations || [];
                        if (translations.length > 0) {
                            resourceTranslations.translations[locale.locale] = translations;
                        }
                    } catch (err) {
                        logger.debug(`Could not get translations for ${resource.resourceId} (${locale.locale}): ${err.message}`);
                    }
                }

                if (Object.keys(resourceTranslations.translations).length > 0) {
                    allTranslations[resourceType].push(resourceTranslations);
                    resourceCount++;
                    totalExported++;
                }
            }

            if (resourceCount > 0) {
                logger.success(`  ${resourceType}: ${resourceCount} resources with translations exported`);
            }
        } catch (err) {
            logger.warn(`Could not get translatable resources for ${resourceType}: ${err.message}`);
        }
    }

    const data = { locales, primaryLocale, translations: allTranslations };
    await saveData('translations', data);

    logger.success(`Exported translations for ${totalExported} resources across ${locales.length} locales`);
    return data;
}

// ─── Import ───────────────────────────────────────────────

export async function importTranslations(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Translations');
    const data = await loadData('translations');
    if (!data) {
        logger.warn('No translations data found. Run export first.');
        return 0;
    }

    const { locales, translations } = data;
    if (!locales || locales.length === 0) {
        logger.info('No locales to import');
        return 0;
    }

    // Enable locales on target store
    logger.info(`Enabling ${locales.length} locales on target store...`);
    for (const locale of locales) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would enable locale: ${locale.locale}`);
            continue;
        }
        try {
            const enableMutation = `
                mutation EnableLocale($locale: String!) {
                    shopLocaleEnable(locale: $locale) {
                        shopLocale { locale published }
                        userErrors { field message }
                    }
                }
            `;
            const result = await targetClient.graphql(enableMutation, { locale: locale.locale });
            const errors = result?.shopLocaleEnable?.userErrors || [];
            if (errors.length > 0 && !errors.some(e => e.message?.includes('already'))) {
                logger.warn(`Locale ${locale.locale} errors: ${JSON.stringify(errors)}`);
            } else {
                logger.success(`Enabled locale: ${locale.locale}`);
            }
        } catch (err) {
            logger.warn(`Could not enable locale ${locale.locale}: ${err.message}`);
        }
    }

    // Publish locales
    for (const locale of locales) {
        if (dryRun) continue;
        if (locale.published) {
            try {
                const publishMutation = `
                    mutation PublishLocale($locale: String!) {
                        shopLocaleUpdate(locale: $locale, shopLocale: { published: true }) {
                            shopLocale { locale published }
                            userErrors { field message }
                        }
                    }
                `;
                await targetClient.graphql(publishMutation, { locale: locale.locale });
            } catch (err) {
                logger.debug(`Could not publish locale ${locale.locale}: ${err.message}`);
            }
        }
    }

    // Cache target shop ID
    let targetShopId = null;
    try {
        const shopData = await targetClient.graphql('{ shop { id } }');
        targetShopId = shopData?.shop?.id;
    } catch { /* skip */ }

    // Pre-fetch target translatable resources for content-match types
    const targetResourceCache = {};

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    for (const [resourceType, resources] of Object.entries(translations)) {
        if (!resources || resources.length === 0) continue;

        logger.info(`Importing ${resourceType} translations (${resources.length} resources)...`);

        const mapping = RESOURCE_MAP[resourceType];
        const isContentMatch = MATCH_BY_CONTENT_TYPES.has(resourceType);

        // Pre-fetch target resources for content matching
        if (isContentMatch && !targetResourceCache[resourceType]) {
            try {
                targetResourceCache[resourceType] = await targetClient.graphqlAll(
                    TRANSLATABLE_RESOURCES_QUERY,
                    { resourceType },
                    'translatableResources'
                );
                logger.debug(`  Cached ${targetResourceCache[resourceType].length} target ${resourceType} resources`);
            } catch (err) {
                logger.debug(`  Could not cache target ${resourceType}: ${err.message}`);
                targetResourceCache[resourceType] = [];
            }
        }

        let typeSkipped = 0;
        let typeImportedCount = 0;

        for (const resource of resources) {
            const sourceId = extractId(resource.resourceId);

            // Find the target resource ID
            let targetResourceId = null;

            if (resourceType === 'SHOP') {
                targetResourceId = targetShopId;
            } else if (isContentMatch) {
                // Try ID mapping first
                if (mapping) {
                    const targetId = idMapper.get(mapping.mapperKey, sourceId);
                    if (targetId) {
                        targetResourceId = buildGid(mapping.gidType, targetId);
                    }
                }

                // If no mapping, match by content
                if (!targetResourceId) {
                    targetResourceId = matchByContent(
                        resource,
                        targetResourceCache[resourceType] || []
                    );
                }
            } else if (mapping) {
                const targetId = idMapper.get(mapping.mapperKey, sourceId);
                if (targetId) {
                    targetResourceId = buildGid(mapping.gidType, targetId);
                }
            }

            if (!targetResourceId) {
                const contentHint = (resource.translatableContent || []).find(c => c.key === 'title' || c.key === 'value')?.value || '';
                logger.debug(`No target mapping for ${resourceType} ${sourceId}${contentHint ? ` ("${contentHint.substring(0, 50)}")` : ''}, skipping`);
                typeSkipped++;
                skipped++;
                continue;
            }
            typeImportedCount++;

            // Get the digests from the target resource
            let targetDigests = {};
            try {
                const digestQuery = `
                    query GetDigests($resourceId: ID!) {
                        translatableResource(resourceId: $resourceId) {
                            translatableContent {
                                key
                                digest
                                locale
                            }
                        }
                    }
                `;
                const digestData = await targetClient.graphql(digestQuery, { resourceId: targetResourceId });
                const content = digestData?.translatableResource?.translatableContent || [];
                for (const c of content) {
                    targetDigests[c.key] = c.digest;
                }
            } catch (err) {
                logger.debug(`Could not get digests for ${targetResourceId}: ${err.message}`);
                skipped++;
                continue;
            }

            // Register translations for each locale
            for (const [locale, trans] of Object.entries(resource.translations)) {
                if (dryRun) {
                    logger.info(`[DRY RUN] Would import ${trans.length} translations for ${resourceType} → ${locale}`);
                    imported++;
                    continue;
                }

                const translationInputs = trans
                    .filter(t => t.value && targetDigests[t.key])
                    .map(t => ({
                        key: t.key,
                        value: t.value,
                        locale,
                        translatableContentDigest: targetDigests[t.key],
                    }));

                if (translationInputs.length === 0) continue;

                // Batch by unique keys — Shopify limits unique keys per mutation
                // Group translations by key, then batch by keys (max 20 unique keys per call)
                const BATCH_SIZE = 20;
                const batches = [];
                for (let i = 0; i < translationInputs.length; i += BATCH_SIZE) {
                    batches.push(translationInputs.slice(i, i + BATCH_SIZE));
                }

                let localeRegistered = 0;
                let localeFailed = false;

                for (const batch of batches) {
                    try {
                        const registerMutation = `
                            mutation RegisterTranslations($resourceId: ID!, $translations: [TranslationInput!]!) {
                                translationsRegister(resourceId: $resourceId, translations: $translations) {
                                    translations { key value locale }
                                    userErrors { field message }
                                }
                            }
                        `;

                        const result = await targetClient.graphql(registerMutation, {
                            resourceId: targetResourceId,
                            translations: batch,
                        });

                        const registered = result?.translationsRegister?.translations?.length || 0;
                        const errors = result?.translationsRegister?.userErrors || [];
                        localeRegistered += registered;

                        if (errors.length > 0) {
                            logger.warn(`Translation errors for ${resourceType} ${sourceId} (${locale}): ${JSON.stringify(errors)}`);
                            localeFailed = true;
                        }
                    } catch (err) {
                        logger.error(`Failed to register translations for ${targetResourceId} (${locale}): ${err.message}`);
                        localeFailed = true;
                    }
                }

                if (localeRegistered > 0) {
                    imported++;
                    if (batches.length > 1) {
                        logger.debug(`  ✓ ${resourceType} ${sourceId} → ${locale}: ${localeRegistered} translations (${batches.length} batches)`);
                    } else {
                        logger.debug(`  ✓ ${resourceType} ${sourceId} → ${locale}: ${localeRegistered} translations`);
                    }
                }
                if (localeFailed) {
                    failed++;
                }
            }
        }

        if (typeSkipped > 0) {
            logger.warn(`  ${resourceType}: ${typeSkipped}/${resources.length} resources could not be matched to target (skipped)`);
        }
        logger.success(`  ${resourceType}: matched ${typeImportedCount}/${resources.length}, skipped ${typeSkipped}`);
    }

    logger.info(`Translations summary: imported=${imported}, skipped=${skipped}, failed=${failed}`);
    const totalCount = Object.values(translations).reduce((sum, arr) => sum + arr.length, 0);
    logger.stats('Translations', totalCount, imported);
    return imported;
}

// ─── Helpers ──────────────────────────────────────────────

function matchByContent(sourceResource, targetResources) {
    const sourceContent = sourceResource.translatableContent || [];

    // Strategy 1: Match by title (exact)
    const sourceTitle = sourceContent.find(c => c.key === 'title')?.value;
    if (sourceTitle) {
        for (const tr of targetResources) {
            const targetTitle = (tr.translatableContent || []).find(c => c.key === 'title')?.value;
            if (targetTitle && sourceTitle === targetTitle) {
                return tr.resourceId;
            }
        }
    }

    // Strategy 2: Match by body (first 200 chars)
    const sourceBody = sourceContent.find(c => c.key === 'body')?.value;
    if (sourceBody) {
        for (const tr of targetResources) {
            const targetBody = (tr.translatableContent || []).find(c => c.key === 'body')?.value;
            if (targetBody && sourceBody.substring(0, 200) === targetBody.substring(0, 200)) {
                return tr.resourceId;
            }
        }
    }

    // Strategy 3: Match by "value" key (for metafields)
    const sourceValue = sourceContent.find(c => c.key === 'value')?.value;
    if (sourceValue) {
        for (const tr of targetResources) {
            const targetValue = (tr.translatableContent || []).find(c => c.key === 'value')?.value;
            if (targetValue && sourceValue === targetValue) {
                return tr.resourceId;
            }
        }
    }

    // Strategy 4: Full content fingerprint (all key:value pairs)
    const sourceFingerprint = sourceContent
        .filter(c => c.value)
        .map(c => `${c.key}:${c.value.substring(0, 100)}`)
        .sort()
        .join('|');
    if (sourceFingerprint) {
        for (const tr of targetResources) {
            const targetFingerprint = (tr.translatableContent || [])
                .filter(c => c.value)
                .map(c => `${c.key}:${c.value.substring(0, 100)}`)
                .sort()
                .join('|');
            if (targetFingerprint && sourceFingerprint === targetFingerprint) {
                return tr.resourceId;
            }
        }
    }

    // Strategy 5: Single target resource — match directly (e.g. SHOP, unique types)
    if (targetResources.length === 1) {
        return targetResources[0].resourceId;
    }

    // Strategy 6: Match by key set signature
    const sourceKeys = sourceContent.map(c => c.key).sort().join(',');
    for (const tr of targetResources) {
        const targetKeys = (tr.translatableContent || []).map(c => c.key).sort().join(',');
        if (sourceKeys === targetKeys && sourceKeys.length > 0) {
            return tr.resourceId;
        }
    }

    return null;
}
