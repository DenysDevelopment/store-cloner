import { saveData, loadData, extractId } from './utils.js';

export async function exportCollections(sourceClient, logger) {
    logger.section('Exporting Collections');

    // Smart collections
    const smartCollections = await sourceClient.restGetAll('/smart_collections.json', 'smart_collections');
    logger.info(`Found ${smartCollections.length} smart collections`);

    // Custom collections
    const customCollections = await sourceClient.restGetAll('/custom_collections.json', 'custom_collections');
    logger.info(`Found ${customCollections.length} custom collections`);

    // For custom collections, get their product collects
    for (const col of customCollections) {
        try {
            const collects = await sourceClient.restGetAll(
                `/collects.json?collection_id=${col.id}`,
                'collects'
            );
            col._collects = collects;
        } catch (err) {
            logger.warn(`Could not get collects for collection ${col.id}: ${err.message}`);
            col._collects = [];
        }
    }

    // Also get collection metafields
    for (const col of [...smartCollections, ...customCollections]) {
        try {
            const mfs = await sourceClient.restGetAll(
                `/collections/${col.id}/metafields.json`,
                'metafields'
            );
            col._metafields = mfs;
        } catch {
            col._metafields = [];
        }
    }

    const data = { smartCollections, customCollections };
    await saveData('collections', data);
    logger.success(`Exported ${smartCollections.length + customCollections.length} collections total`);
    return data;
}

export async function importCollections(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Collections');
    const data = await loadData('collections');
    if (!data) {
        logger.warn('No collections data found. Run export first.');
        return 0;
    }

    let imported = 0;

    // Smart collections
    for (const col of data.smartCollections || []) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create smart collection: ${col.title}`);
            imported++;
            continue;
        }
        try {
            const payload = {
                smart_collection: {
                    title: col.title,
                    handle: col.handle,
                    body_html: col.body_html,
                    sort_order: col.sort_order,
                    template_suffix: col.template_suffix || '',
                    published: col.published,
                    rules: (col.rules || []).map(r => ({
                        column: r.column,
                        relation: r.relation,
                        condition: r.condition,
                    })),
                    disjunctive: col.disjunctive,
                    image: col.image ? { src: col.image.src, alt: col.image.alt || '' } : undefined,
                    metafields: (col._metafields || []).map(mf => ({
                        namespace: mf.namespace,
                        key: mf.key,
                        value: mf.value,
                        type: mf.type,
                    })),
                },
            };

            const result = await targetClient.rest('POST', '/smart_collections.json', payload);
            if (result?.smart_collection) {
                idMapper.set('collections', String(col.id), String(result.smart_collection.id));
                idMapper.setHandleMap('collections', col.handle, String(col.id), String(result.smart_collection.id));
                imported++;
                logger.success(`Created smart collection: ${col.title}`);
            }
        } catch (err) {
            logger.error(`Failed to create smart collection "${col.title}": ${err.message}`);
        }
    }

    // Custom collections
    for (const col of data.customCollections || []) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create custom collection: ${col.title}`);
            imported++;
            continue;
        }
        try {
            const payload = {
                custom_collection: {
                    title: col.title,
                    handle: col.handle,
                    body_html: col.body_html,
                    sort_order: col.sort_order,
                    template_suffix: col.template_suffix || '',
                    published: col.published,
                    image: col.image ? { src: col.image.src, alt: col.image.alt || '' } : undefined,
                    metafields: (col._metafields || []).map(mf => ({
                        namespace: mf.namespace,
                        key: mf.key,
                        value: mf.value,
                        type: mf.type,
                    })),
                },
            };

            const result = await targetClient.rest('POST', '/custom_collections.json', payload);
            if (result?.custom_collection) {
                const targetColId = result.custom_collection.id;
                idMapper.set('collections', String(col.id), String(targetColId));
                idMapper.setHandleMap('collections', col.handle, String(col.id), String(targetColId));

                // Add products to the collection via collects
                const collects = col._collects || [];
                if (collects.length > 0) {
                    let addedProducts = 0;
                    let skippedProducts = 0;
                    for (const collect of collects) {
                        const targetProductId = idMapper.get('products', String(collect.product_id));
                        if (targetProductId) {
                            try {
                                await targetClient.rest('POST', '/collects.json', {
                                    collect: {
                                        collection_id: targetColId,
                                        product_id: parseInt(targetProductId),
                                    },
                                });
                                addedProducts++;
                            } catch (err) {
                                logger.warn(`Could not add product ${collect.product_id} to collection: ${err.message}`);
                            }
                        } else {
                            skippedProducts++;
                        }
                    }
                    if (skippedProducts > 0) {
                        logger.warn(`Collection "${col.title}": ${skippedProducts}/${collects.length} products skipped (no ID mapping — products module may be disabled)`);
                    }
                    if (addedProducts > 0) {
                        logger.info(`Collection "${col.title}": added ${addedProducts} products`);
                    }
                }

                imported++;
                logger.success(`Created custom collection: ${col.title}`);
            }
        } catch (err) {
            logger.error(`Failed to create custom collection "${col.title}": ${err.message}`);
        }
    }

    logger.stats('Collections', (data.smartCollections?.length || 0) + (data.customCollections?.length || 0), imported);
    return imported;
}
