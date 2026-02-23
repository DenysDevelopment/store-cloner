import { saveData, loadData, extractId } from './utils.js';

const METAFIELD_DEFS_QUERY = `
  query MetafieldDefs($cursor: String, $ownerType: MetafieldOwnerType!) {
    metafieldDefinitions(first: 50, after: $cursor, ownerType: $ownerType) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          name
          namespace
          key
          type { name }
          description
          ownerType
          pinnedPosition
          validations { name value }
        }
      }
    }
  }
`;

const OWNER_TYPES = [
    'PRODUCT', 'VARIANT', 'COLLECTION', 'CUSTOMER',
    'ORDER', 'PAGE', 'ARTICLE', 'BLOG', 'SHOP',
];

export async function exportMetafields(sourceClient, logger) {
    logger.section('Exporting Metafield Definitions');
    const allDefs = [];

    for (const ownerType of OWNER_TYPES) {
        try {
            const defs = await sourceClient.graphqlAll(
                METAFIELD_DEFS_QUERY,
                { ownerType },
                'metafieldDefinitions'
            );
            allDefs.push(...defs);
            if (defs.length > 0) {
                logger.info(`  ${ownerType}: ${defs.length} definitions`);
            }
        } catch (err) {
            logger.warn(`Could not get metafield defs for ${ownerType}: ${err.message}`);
        }
    }

    // Also export shop-level metafields
    let shopMetafields = [];
    try {
        const shopMfRes = await sourceClient.rest('GET', '/metafields.json');
        shopMetafields = shopMfRes?.metafields || [];
    } catch {
        logger.warn('Could not export shop-level metafields');
    }

    const data = { definitions: allDefs, shopMetafields };
    await saveData('metafields', data);
    logger.success(`Exported ${allDefs.length} metafield definitions + ${shopMetafields.length} shop metafields`);
    return data;
}

export async function importMetafields(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Metafield Definitions');
    const data = await loadData('metafields');
    if (!data) {
        logger.warn('No metafields data found. Run export first.');
        return 0;
    }

    let imported = 0;
    let skipped = 0;

    // Create metafield definitions
    for (const def of data.definitions || []) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create metafield def: ${def.namespace}.${def.key} (${def.ownerType})`);
            imported++;
            continue;
        }
        try {
            const mutation = `
        mutation CreateMetafieldDef($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id name namespace key }
            userErrors { field message }
          }
        }
      `;

            const result = await targetClient.graphql(mutation, {
                definition: {
                    name: def.name,
                    namespace: def.namespace,
                    key: def.key,
                    type: def.type?.name,
                    description: def.description || '',
                    ownerType: def.ownerType,
                    validations: (def.validations || []).map(v => ({
                        name: v.name,
                        value: v.value,
                    })),
                },
            });

            if (result?.metafieldDefinitionCreate?.createdDefinition) {
                imported++;
                logger.success(`Created metafield def: ${def.namespace}.${def.key}`);
            } else if (result?.metafieldDefinitionCreate?.userErrors?.length > 0) {
                const errors = result.metafieldDefinitionCreate.userErrors;
                // Skip "already exists" errors
                if (errors.some(e => e.message?.includes('already exists'))) {
                    logger.info(`Metafield def ${def.namespace}.${def.key} already exists, skipping`);
                    skipped++;
                } else {
                    logger.error(`Metafield def errors: ${JSON.stringify(errors)}`);
                }
            }
        } catch (err) {
            logger.error(`Failed to create metafield def ${def.namespace}.${def.key}: ${err.message}`);
        }
    }

    // Import shop-level metafields
    for (const mf of data.shopMetafields || []) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create shop metafield: ${mf.namespace}.${mf.key}`);
            imported++;
            continue;
        }
        try {
            await targetClient.rest('POST', '/metafields.json', {
                metafield: {
                    namespace: mf.namespace,
                    key: mf.key,
                    value: mf.value,
                    type: mf.type,
                },
            });
            imported++;
            logger.success(`Created shop metafield: ${mf.namespace}.${mf.key}`);
        } catch (err) {
            logger.error(`Failed to create shop metafield: ${err.message}`);
        }
    }

    if (skipped > 0) {
        logger.info(`Metafield definitions: ${skipped} already existed (skipped)`);
    }
    logger.stats('Metafields', (data.definitions?.length || 0) + (data.shopMetafields?.length || 0), imported + skipped);
    return imported;
}
