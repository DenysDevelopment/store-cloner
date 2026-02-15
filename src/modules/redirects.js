import { saveData, loadData } from './utils.js';

export async function exportRedirects(sourceClient, logger) {
    logger.section('Exporting Redirects');
    const redirects = await sourceClient.restGetAll('/redirects.json', 'redirects');
    await saveData('redirects', redirects);
    logger.success(`Exported ${redirects.length} redirects`);
    return redirects;
}

export async function importRedirects(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Redirects');
    const redirects = await loadData('redirects');
    if (!redirects) {
        logger.warn('No redirects data found. Run export first.');
        return 0;
    }

    let imported = 0;
    for (const redirect of redirects) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create redirect: ${redirect.path} → ${redirect.target}`);
            imported++;
            continue;
        }
        try {
            await targetClient.rest('POST', '/redirects.json', {
                redirect: {
                    path: redirect.path,
                    target: redirect.target,
                },
            });
            imported++;
            logger.success(`Created redirect: ${redirect.path} → ${redirect.target}`);
        } catch (err) {
            logger.error(`Failed to create redirect "${redirect.path}": ${err.message}`);
        }
    }

    logger.stats('Redirects', redirects.length, imported);
    return imported;
}
