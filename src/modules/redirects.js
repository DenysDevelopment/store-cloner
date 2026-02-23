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

    // Pre-fetch existing redirects to avoid duplicates
    let existingPaths = new Set();
    if (!dryRun) {
        try {
            const existing = await targetClient.restGetAll('/redirects.json', 'redirects');
            existingPaths = new Set(existing.map(r => r.path));
            if (existingPaths.size > 0) {
                logger.info(`Found ${existingPaths.size} existing redirects on target store`);
            }
        } catch (err) {
            logger.warn(`Could not fetch existing redirects: ${err.message}`);
        }
    }

    let imported = 0;
    let skipped = 0;
    for (const redirect of redirects) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create redirect: ${redirect.path} → ${redirect.target}`);
            imported++;
            continue;
        }

        // Skip if redirect path already exists
        if (existingPaths.has(redirect.path)) {
            logger.info(`Redirect "${redirect.path}" already exists, skipping`);
            skipped++;
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
            if (err.message?.includes('already exists') || err.message?.includes('taken')) {
                logger.info(`Redirect "${redirect.path}" already exists, skipping`);
                skipped++;
            } else {
                logger.error(`Failed to create redirect "${redirect.path}": ${err.message}`);
            }
        }
    }

    if (skipped > 0) {
        logger.info(`Redirects: ${skipped} already existed (skipped)`);
    }
    logger.stats('Redirects', redirects.length, imported + skipped);
    return imported;
}
