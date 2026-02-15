import { saveData, loadData } from './utils.js';

// ─── GraphQL Queries ──────────────────────────────────────

const SHOP_DETAILS_QUERY = `
  {
    shop {
      id
      name
      email
      description
      currencyCode
      billingAddress { address1 address2 city province zip country countryCodeV2 phone }
      primaryDomain { host url }
      myshopifyDomain
      plan { displayName }
      unitSystem
      weightUnit
      timezoneAbbreviation
      ianaTimezone
    }
  }
`;

const SHOP_LOCALES_QUERY = `
  {
    shopLocales {
      locale
      primary
      published
    }
  }
`;

const SHOP_POLICIES_QUERY = `
  {
    shop {
      privacyPolicy { title body }
      refundPolicy { title body }
      termsOfService { title body }
      shippingPolicy { title body }
      subscriptionPolicy { title body }
    }
  }
`;

const PAYMENT_SETTINGS_QUERY = `
  {
    shop {
      currencyCode
      currencyFormats {
        moneyFormat
        moneyInEmailsFormat
        moneyWithCurrencyFormat
        moneyWithCurrencyInEmailsFormat
      }
      enabledPresentmentCurrencies
    }
  }
`;

const MARKETS_QUERY = `
  query Markets($cursor: String) {
    markets(first: 50, after: $cursor) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          name
          handle
          enabled
          primary
          regions(first: 50) {
            edges {
              node {
                id
                name
                ... on MarketRegionCountry {
                  code
                  currency { currencyCode }
                }
              }
            }
          }
          webPresence {
            domain { host }
            rootUrls { locale url }
            defaultLocale
            alternateLocales
            subfolderSuffix
          }
        }
      }
    }
  }
`;

// ─── Export ────────────────────────────────────────────────

export async function exportShopSettings(sourceClient, logger) {
    logger.section('Exporting Shop Settings');

    const data = {};

    // 1. Shop info via REST
    try {
        const shopRes = await sourceClient.rest('GET', '/shop.json');
        data.shop = shopRes?.shop || {};
        logger.info(`Shop: ${data.shop.name} (${data.shop.domain})`);
    } catch (err) {
        logger.warn(`Could not get shop info: ${err.message}`);
    }

    // 2. Shop details via GraphQL
    try {
        const shopGql = await sourceClient.graphql(SHOP_DETAILS_QUERY);
        data.shopDetails = shopGql?.shop || {};
        logger.info(`Shop details: timezone=${data.shopDetails.ianaTimezone}, currency=${data.shopDetails.currencyCode}`);
    } catch (err) {
        logger.warn(`Could not get shop details via GraphQL: ${err.message}`);
    }

    // 3. Locales
    try {
        const localesData = await sourceClient.graphql(SHOP_LOCALES_QUERY);
        data.locales = localesData?.shopLocales || [];
        logger.info(`Locales: ${data.locales.length} (primary: ${data.locales.find(l => l.primary)?.locale || '?'})`);
    } catch (err) {
        logger.warn(`Could not get locales: ${err.message}`);
        data.locales = [];
    }

    // 4. Policies via GraphQL
    try {
        const policiesGql = await sourceClient.graphql(SHOP_POLICIES_QUERY);
        const shopPolicies = policiesGql?.shop || {};
        data.policies = {
            privacyPolicy: shopPolicies.privacyPolicy,
            refundPolicy: shopPolicies.refundPolicy,
            termsOfService: shopPolicies.termsOfService,
            shippingPolicy: shopPolicies.shippingPolicy,
            subscriptionPolicy: shopPolicies.subscriptionPolicy,
        };
        const policyCount = Object.values(data.policies).filter(p => p?.body).length;
        logger.info(`Policies: ${policyCount} with content`);
    } catch (err) {
        logger.warn(`Could not get policies via GraphQL: ${err.message}`);
    }

    // 5. Also get policies via REST (for import compatibility)
    try {
        const policiesRes = await sourceClient.rest('GET', '/policies.json');
        data.policiesRest = policiesRes?.policies || [];
    } catch {
        data.policiesRest = [];
    }

    // 6. Currency / payment formats
    try {
        const paymentData = await sourceClient.graphql(PAYMENT_SETTINGS_QUERY);
        data.currencySettings = {
            currencyCode: paymentData?.shop?.currencyCode,
            currencyFormats: paymentData?.shop?.currencyFormats,
            enabledPresentmentCurrencies: paymentData?.shop?.enabledPresentmentCurrencies || [],
        };
        logger.info(`Currencies: ${data.currencySettings.enabledPresentmentCurrencies.length} presentment currencies`);
    } catch (err) {
        logger.warn(`Could not get currency settings: ${err.message}`);
    }

    // 7. Markets
    try {
        const markets = await sourceClient.graphqlAll(MARKETS_QUERY, {}, 'markets');
        data.markets = markets;
        logger.info(`Markets: ${markets.length}`);
        for (const market of markets) {
            const regions = (market.regions?.edges || []).map(e => e.node);
            const locales = market.webPresence?.alternateLocales || [];
            logger.info(`  ${market.name}: ${regions.length} regions, locales=[${market.webPresence?.defaultLocale || '?'}, ${locales.join(', ')}]`);
        }
    } catch (err) {
        logger.warn(`Could not get markets: ${err.message}`);
        data.markets = [];
    }

    // 8. Countries / shipping zones
    try {
        const countriesRes = await sourceClient.restGetAll('/countries.json', 'countries');
        data.countries = countriesRes;
        logger.info(`Shipping countries: ${data.countries.length}`);
    } catch {
        data.countries = [];
    }

    // 9. Script tags
    try {
        const scriptTags = await sourceClient.restGetAll('/script_tags.json', 'script_tags');
        data.scriptTags = scriptTags;
        logger.info(`Script tags: ${data.scriptTags.length}`);
    } catch {
        data.scriptTags = [];
    }

    // 10. Checkout / cart settings (REST shop endpoint has some of these)
    try {
        data.checkoutSettings = {
            taxes_included: data.shop?.taxes_included,
            tax_shipping: data.shop?.tax_shipping,
            county_taxes: data.shop?.county_taxes,
            checkout_api_supported: data.shop?.checkout_api_supported,
            multi_location_enabled: data.shop?.multi_location_enabled,
            force_ssl: data.shop?.force_ssl,
            password_enabled: data.shop?.password_enabled,
            has_storefront: data.shop?.has_storefront,
            eligible_for_payments: data.shop?.eligible_for_payments,
            requires_extra_payments_agreement: data.shop?.requires_extra_payments_agreement,
            pre_launch_enabled: data.shop?.pre_launch_enabled,
            enabled_presentment_currencies: data.shop?.enabled_presentment_currencies || [],
            money_format: data.shop?.money_format,
            money_with_currency_format: data.shop?.money_with_currency_format,
            weight_unit: data.shop?.weight_unit,
        };
        logger.info(`Checkout settings: extracted from shop data`);
    } catch {
        data.checkoutSettings = {};
    }

    // 11. Notification templates (email templates are readable via REST)
    try {
        // Shopify doesn't provide a direct API for notification templates,
        // but we can capture the info from the shop object
        data.notifications = {
            customer_email: data.shop?.customer_email,
            email: data.shop?.email,
        };
        logger.info(`Notification email: ${data.shop?.customer_email || data.shop?.email || '?'}`);
    } catch {
        data.notifications = {};
    }

    await saveData('shop-settings', data);
    logger.success('Exported shop settings');
    return data;
}

// ─── Import ───────────────────────────────────────────────

export async function importShopSettings(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Shop Settings');
    const data = await loadData('shop-settings');
    if (!data) {
        logger.warn('No shop settings data found. Run export first.');
        return 0;
    }

    let imported = 0;

    // 1. Enable and publish locales
    if (data.locales && data.locales.length > 0) {
        logger.info('Setting up locales...');
        const secondaryLocales = data.locales.filter(l => !l.primary);

        for (const locale of secondaryLocales) {
            if (dryRun) {
                logger.info(`[DRY RUN] Would enable locale: ${locale.locale} (published: ${locale.published})`);
                continue;
            }
            try {
                // Enable locale
                const enableResult = await targetClient.graphql(`
                    mutation EnableLocale($locale: String!) {
                        shopLocaleEnable(locale: $locale) {
                            shopLocale { locale published }
                            userErrors { field message }
                        }
                    }
                `, { locale: locale.locale });

                const errors = enableResult?.shopLocaleEnable?.userErrors || [];
                if (errors.length > 0 && !errors.some(e => e.message?.includes('already'))) {
                    logger.warn(`Locale ${locale.locale}: ${JSON.stringify(errors)}`);
                } else {
                    logger.success(`Enabled locale: ${locale.locale}`);
                }

                // Publish if needed
                if (locale.published) {
                    await targetClient.graphql(`
                        mutation PublishLocale($locale: String!) {
                            shopLocaleUpdate(locale: $locale, shopLocale: { published: true }) {
                                shopLocale { locale published }
                                userErrors { field message }
                            }
                        }
                    `, { locale: locale.locale });
                    logger.success(`Published locale: ${locale.locale}`);
                }
                imported++;
            } catch (err) {
                logger.error(`Failed to setup locale ${locale.locale}: ${err.message}`);
            }
        }
    }

    // 2. Policies via GraphQL mutations
    if (data.policies) {
        logger.info('Updating policies...');
        const policyMap = [
            { key: 'refundPolicy', mutation: 'shopPolicyUpdate', type: 'REFUND_POLICY' },
            { key: 'privacyPolicy', mutation: 'shopPolicyUpdate', type: 'PRIVACY_POLICY' },
            { key: 'termsOfService', mutation: 'shopPolicyUpdate', type: 'TERMS_OF_SERVICE' },
            { key: 'shippingPolicy', mutation: 'shopPolicyUpdate', type: 'SHIPPING_POLICY' },
            { key: 'subscriptionPolicy', mutation: 'shopPolicyUpdate', type: 'SUBSCRIPTION_POLICY' },
        ];

        for (const pm of policyMap) {
            const policy = data.policies[pm.key];
            if (!policy?.body) continue;

            if (dryRun) {
                logger.info(`[DRY RUN] Would update policy: ${pm.key}`);
                continue;
            }

            try {
                const result = await targetClient.graphql(`
                    mutation UpdatePolicy($policy: ShopPolicyInput!) {
                        shopPolicyUpdate(shopPolicy: $policy) {
                            shopPolicy { body }
                            userErrors { field message }
                        }
                    }
                `, {
                    policy: {
                        type: pm.type,
                        body: policy.body,
                    },
                });

                const errors = result?.shopPolicyUpdate?.userErrors || [];
                if (errors.length > 0) {
                    logger.warn(`Policy ${pm.key}: ${JSON.stringify(errors)}`);
                } else {
                    logger.success(`Updated policy: ${pm.key}`);
                    imported++;
                }
            } catch (err) {
                logger.warn(`Could not update ${pm.key}: ${err.message}`);
            }
        }
    }

    // 3. Markets
    if (data.markets && data.markets.length > 0) {
        logger.info('Setting up markets...');

        for (const market of data.markets) {
            // Skip primary market (already exists)
            if (market.primary) {
                logger.info(`Skipping primary market: ${market.name}`);

                // But still configure web presence for primary market
                if (market.webPresence) {
                    await configureMarketWebPresence(targetClient, market, logger, dryRun);
                }
                continue;
            }

            if (dryRun) {
                logger.info(`[DRY RUN] Would create market: ${market.name}`);
                continue;
            }

            try {
                const regions = (market.regions?.edges || []).map(e => e.node);
                const countryCodes = regions
                    .filter(r => r.code)
                    .map(r => ({ code: r.code }));

                if (countryCodes.length === 0) {
                    logger.warn(`Market "${market.name}" has no country regions, skipping`);
                    continue;
                }

                const createResult = await targetClient.graphql(`
                    mutation MarketCreate($name: String!, $regions: [MarketRegionCreateInput!]!) {
                        marketCreate(input: { name: $name, regions: $regions, enabled: true }) {
                            market {
                                id
                                name
                                handle
                            }
                            userErrors { field message }
                        }
                    }
                `, {
                    name: market.name,
                    regions: countryCodes,
                });

                const errors = createResult?.marketCreate?.userErrors || [];
                if (errors.length > 0) {
                    if (errors.some(e => e.message?.includes('already') || e.message?.includes('exists'))) {
                        logger.info(`Market "${market.name}" already exists`);
                    } else {
                        logger.warn(`Market "${market.name}": ${JSON.stringify(errors)}`);
                    }
                } else if (createResult?.marketCreate?.market) {
                    logger.success(`Created market: ${market.name}`);
                    imported++;

                    // Configure web presence (subfolder locale routing)
                    if (market.webPresence) {
                        await configureMarketWebPresence(targetClient, market, logger, dryRun);
                    }
                }
            } catch (err) {
                logger.error(`Failed to create market "${market.name}": ${err.message}`);
            }
        }
    }

    // 4. Presentment currencies
    if (data.currencySettings?.enabledPresentmentCurrencies?.length > 0) {
        logger.info('Enabling presentment currencies...');
        for (const currency of data.currencySettings.enabledPresentmentCurrencies) {
            if (dryRun) {
                logger.info(`[DRY RUN] Would enable currency: ${currency}`);
                continue;
            }
            try {
                await targetClient.graphql(`
                    mutation EnableCurrency($currencyCode: CurrencyCode!) {
                        currencySettingsUpdate(input: { enabledPresentmentCurrencies: [$currencyCode] }) {
                            currencySettings { currencyCode }
                            userErrors { field message }
                        }
                    }
                `, { currencyCode: currency });
                logger.debug(`Enabled currency: ${currency}`);
            } catch (err) {
                logger.debug(`Could not enable currency ${currency}: ${err.message}`);
            }
        }
    }

    // 5. Script tags
    for (const tag of data.scriptTags || []) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create script tag: ${tag.src}`);
            imported++;
            continue;
        }
        try {
            await targetClient.rest('POST', '/script_tags.json', {
                script_tag: {
                    event: tag.event,
                    src: tag.src,
                    display_scope: tag.display_scope,
                },
            });
            imported++;
            logger.success(`Created script tag: ${tag.src}`);
        } catch (err) {
            logger.error(`Failed to create script tag: ${err.message}`);
        }
    }

    // Summary of manual steps
    logger.info('');
    logger.warn('The following settings need MANUAL configuration on the target store:');
    logger.warn('  • Payment providers (Settings → Payments)');
    logger.warn('  • Shipping rates (Settings → Shipping and delivery)');
    logger.warn('  • Taxes (Settings → Taxes and duties)');
    logger.warn('  • Domain (Settings → Domains)');
    logger.warn('  • Checkout settings (Settings → Checkout)');
    logger.warn('  • Notifications (Settings → Notifications)');
    logger.warn('  • Staff accounts & permissions');

    if (data.checkoutSettings) {
        logger.info('');
        logger.info('Source store settings for reference:');
        logger.info(`  Money format: ${data.checkoutSettings.money_format || '?'}`);
        logger.info(`  Weight unit: ${data.checkoutSettings.weight_unit || '?'}`);
        logger.info(`  Taxes included: ${data.checkoutSettings.taxes_included ?? '?'}`);
        logger.info(`  Presentment currencies: ${(data.checkoutSettings.enabled_presentment_currencies || []).join(', ') || 'default'}`);
    }

    logger.stats('Shop Settings', 1, imported);
    return imported;
}

// ─── Helpers ──────────────────────────────────────────────

async function configureMarketWebPresence(targetClient, market, logger, dryRun) {
    if (dryRun) return;

    const webPresence = market.webPresence;
    if (!webPresence) return;

    try {
        // Get target markets to find the corresponding one
        const targetMarkets = await targetClient.graphql(`
            query { markets(first: 50) { edges { node { id name handle primary webPresence { id } } } } }
        `);

        const targetMarket = (targetMarkets?.markets?.edges || [])
            .map(e => e.node)
            .find(m => m.name === market.name || m.handle === market.handle || (market.primary && m.primary));

        if (!targetMarket || !targetMarket.webPresence?.id) {
            logger.debug(`Could not find target market for "${market.name}" web presence config`);
            return;
        }

        // Configure web presence (locales)
        if (webPresence.alternateLocales?.length > 0) {
            // First enable those locales on the shop
            for (const locale of webPresence.alternateLocales) {
                try {
                    await targetClient.graphql(`
                        mutation EnableLocale($locale: String!) {
                            shopLocaleEnable(locale: $locale) {
                                shopLocale { locale }
                                userErrors { field message }
                            }
                        }
                    `, { locale });
                } catch {
                    // locale might already be enabled
                }
            }

            try {
                await targetClient.graphql(`
                    mutation UpdateWebPresence($webPresenceId: ID!, $input: MarketWebPresenceUpdateInput!) {
                        marketWebPresenceUpdate(webPresenceId: $webPresenceId, webPresence: $input) {
                            marketWebPresence { id defaultLocale alternateLocales }
                            userErrors { field message }
                        }
                    }
                `, {
                    webPresenceId: targetMarket.webPresence.id,
                    input: {
                        defaultLocale: webPresence.defaultLocale,
                        alternateLocales: webPresence.alternateLocales,
                    },
                });
                logger.success(`Configured web presence for market: ${market.name} (locales: ${webPresence.defaultLocale}, ${webPresence.alternateLocales.join(', ')})`);
            } catch (err) {
                logger.warn(`Could not update web presence for "${market.name}": ${err.message}`);
            }
        }
    } catch (err) {
        logger.debug(`Web presence config failed for "${market.name}": ${err.message}`);
    }
}
