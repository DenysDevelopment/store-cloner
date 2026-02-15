import { saveData, loadData } from './utils.js';

export async function exportPages(sourceClient, logger) {
    logger.section('Exporting Pages');
    const pages = await sourceClient.restGetAll('/pages.json', 'pages');

    // Get metafields for each page
    for (const page of pages) {
        try {
            const mfs = await sourceClient.restGetAll(`/pages/${page.id}/metafields.json`, 'metafields');
            page._metafields = mfs;
        } catch {
            page._metafields = [];
        }
    }

    await saveData('pages', pages);
    logger.success(`Exported ${pages.length} pages`);
    return pages;
}

export async function importPages(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Pages');
    const pages = await loadData('pages');
    if (!pages) {
        logger.warn('No pages data found. Run export first.');
        return 0;
    }

    let imported = 0;
    for (const page of pages) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create page: ${page.title}`);
            imported++;
            continue;
        }
        try {
            const payload = {
                page: {
                    title: page.title,
                    handle: page.handle,
                    body_html: page.body_html,
                    template_suffix: page.template_suffix || '',
                    published: page.published_at ? true : false,
                    metafields: (page._metafields || []).map(mf => ({
                        namespace: mf.namespace,
                        key: mf.key,
                        value: mf.value,
                        type: mf.type,
                    })),
                },
            };

            const result = await targetClient.rest('POST', '/pages.json', payload);
            if (result?.page) {
                idMapper.set('pages', String(page.id), String(result.page.id));
                idMapper.setHandleMap('pages', page.handle, String(page.id), String(result.page.id));
                imported++;
                logger.success(`Created page: ${page.title}`);
            }
        } catch (err) {
            logger.error(`Failed to create page "${page.title}": ${err.message}`);
        }
    }

    logger.stats('Pages', pages.length, imported);
    return imported;
}
