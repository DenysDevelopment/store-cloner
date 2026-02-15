import { saveData, loadData, extractId } from './utils.js';

const METAOBJECT_DEFS_QUERY = `
  query MetaobjectDefs($cursor: String) {
    metaobjectDefinitions(first: 50, after: $cursor) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          name
          type
          fieldDefinitions {
            name
            key
            type { name }
            description
            required
            validations { name value }
          }
          access { storefront }
          capabilities { publishable { enabled } translatable { enabled } }
        }
      }
    }
  }
`;

const METAOBJECTS_QUERY = `
  query Metaobjects($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 50, after: $cursor) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          handle
          type
          fields {
            key
            value
            type
          }
        }
      }
    }
  }
`;

export async function exportMetaobjects(sourceClient, logger) {
    logger.section('Exporting Metaobjects');

    // Get definitions
    const definitions = await sourceClient.graphqlAll(METAOBJECT_DEFS_QUERY, {}, 'metaobjectDefinitions');
    logger.info(`Found ${definitions.length} metaobject definitions`);

    // Get entries for each type
    for (const def of definitions) {
        try {
            const entries = await sourceClient.graphqlAll(
                METAOBJECTS_QUERY,
                { type: def.type },
                'metaobjects'
            );
            def._entries = entries;
            logger.info(`  ${def.type}: ${entries.length} entries`);
        } catch (err) {
            logger.warn(`Could not get entries for ${def.type}: ${err.message}`);
            def._entries = [];
        }
    }

    await saveData('metaobjects', definitions);
    logger.success(`Exported ${definitions.length} metaobject definitions`);
    return definitions;
}

export async function importMetaobjects(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Metaobjects');
    const definitions = await loadData('metaobjects');
    if (!definitions) {
        logger.warn('No metaobjects data found. Run export first.');
        return 0;
    }

    let imported = 0;

    for (const def of definitions) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create metaobject type: ${def.type} with ${def._entries?.length || 0} entries`);
            imported++;
            continue;
        }
        try {
            // Create definition
            const createDefMutation = `
        mutation CreateMetaobjectDef($definition: MetaobjectDefinitionCreateInput!) {
          metaobjectDefinitionCreate(definition: $definition) {
            metaobjectDefinition { id type }
            userErrors { field message }
          }
        }
      `;

            const defResult = await targetClient.graphql(createDefMutation, {
                definition: {
                    name: def.name,
                    type: def.type,
                    fieldDefinitions: def.fieldDefinitions.map(fd => ({
                        name: fd.name,
                        key: fd.key,
                        type: fd.type?.name,
                        description: fd.description || '',
                        required: fd.required || false,
                        validations: (fd.validations || []).map(v => ({ name: v.name, value: v.value })),
                    })),
                    access: def.access || {},
                    capabilities: def.capabilities || {},
                },
            });

            if (defResult?.metaobjectDefinitionCreate?.userErrors?.length > 0) {
                const errors = defResult.metaobjectDefinitionCreate.userErrors;
                if (!errors.some(e => e.message?.includes('already exists'))) {
                    logger.error(`Metaobject def "${def.type}" errors: ${JSON.stringify(errors)}`);
                    continue;
                }
                logger.info(`Metaobject type ${def.type} already exists, creating entries...`);
            } else {
                logger.success(`Created metaobject definition: ${def.type}`);
            }

            // Create entries
            for (const entry of def._entries || []) {
                try {
                    const createMutation = `
            mutation CreateMetaobject($metaobject: MetaobjectCreateInput!) {
              metaobjectCreate(metaobject: $metaobject) {
                metaobject { id handle }
                userErrors { field message }
              }
            }
          `;

                    const entryResult = await targetClient.graphql(createMutation, {
                        metaobject: {
                            type: def.type,
                            handle: entry.handle,
                            fields: (entry.fields || []).map(f => ({
                                key: f.key,
                                value: f.value,
                            })),
                        },
                    });

                    if (entryResult?.metaobjectCreate?.metaobject) {
                        idMapper.set('metaobjects', extractId(entry.id), extractId(entryResult.metaobjectCreate.metaobject.id));
                        imported++;
                    } else if (entryResult?.metaobjectCreate?.userErrors?.length > 0) {
                        logger.warn(`Metaobject entry errors: ${JSON.stringify(entryResult.metaobjectCreate.userErrors)}`);
                    }
                } catch (err) {
                    logger.error(`Failed to create metaobject entry: ${err.message}`);
                }
            }
        } catch (err) {
            logger.error(`Failed to create metaobject type "${def.type}": ${err.message}`);
        }
    }

    logger.stats('Metaobjects', definitions.length, imported);
    return imported;
}
