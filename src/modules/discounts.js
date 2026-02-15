import { saveData, loadData, extractId } from './utils.js';

const PRICE_RULES_QUERY = `
  query PriceRules($cursor: String) {
    priceRules(first: 50, after: $cursor) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          title
          target
          allocationMethod
          valueV2 { amount currencyCode }
          customerSelection
          startsAt
          endsAt
          usageLimit
          oncePerCustomer
          prerequisiteSubtotalRange { greaterThanOrEqualTo }
          prerequisiteQuantityRange { greaterThanOrEqualTo }
          entitlementToPrerequisiteQuantityRatio { entitlementQuantity prerequisiteQuantity }
          discountCodes(first: 50) {
            edges {
              node {
                id
                code
                usageCount
              }
            }
          }
        }
      }
    }
  }
`;

export async function exportDiscounts(sourceClient, logger) {
    logger.section('Exporting Discounts');

    // Use REST for price rules — more fields available
    const priceRules = await sourceClient.restGetAll('/price_rules.json', 'price_rules');

    for (const rule of priceRules) {
        try {
            const codes = await sourceClient.restGetAll(
                `/price_rules/${rule.id}/discount_codes.json`,
                'discount_codes'
            );
            rule._discount_codes = codes;
        } catch (err) {
            logger.warn(`Could not get discount codes for rule ${rule.id}: ${err.message}`);
            rule._discount_codes = [];
        }
    }

    await saveData('discounts', priceRules);
    logger.success(`Exported ${priceRules.length} price rules`);
    return priceRules;
}

export async function importDiscounts(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Discounts');
    const priceRules = await loadData('discounts');
    if (!priceRules) {
        logger.warn('No discounts data found. Run export first.');
        return 0;
    }

    let imported = 0;
    for (const rule of priceRules) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create price rule: ${rule.title}`);
            imported++;
            continue;
        }
        try {
            const payload = {
                price_rule: {
                    title: rule.title,
                    target_type: rule.target_type,
                    target_selection: rule.target_selection,
                    allocation_method: rule.allocation_method,
                    value_type: rule.value_type,
                    value: rule.value,
                    customer_selection: rule.customer_selection,
                    starts_at: rule.starts_at,
                    ends_at: rule.ends_at,
                    usage_limit: rule.usage_limit,
                    once_per_customer: rule.once_per_customer,
                    prerequisite_subtotal_range: rule.prerequisite_subtotal_range,
                    prerequisite_quantity_range: rule.prerequisite_quantity_range,
                },
            };

            const result = await targetClient.rest('POST', '/price_rules.json', payload);
            if (result?.price_rule) {
                const targetRuleId = result.price_rule.id;
                idMapper.set('price_rules', String(rule.id), String(targetRuleId));
                imported++;
                logger.success(`Created price rule: ${rule.title}`);

                // Create discount codes
                for (const code of rule._discount_codes || []) {
                    try {
                        await targetClient.rest('POST', `/price_rules/${targetRuleId}/discount_codes.json`, {
                            discount_code: { code: code.code },
                        });
                        logger.success(`  Created discount code: ${code.code}`);
                    } catch (err) {
                        logger.warn(`  Could not create discount code "${code.code}": ${err.message}`);
                    }
                }
            }
        } catch (err) {
            logger.error(`Failed to create price rule "${rule.title}": ${err.message}`);
        }
    }

    logger.stats('Discounts', priceRules.length, imported);
    return imported;
}
