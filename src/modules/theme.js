import fs from 'fs/promises';
import { join } from 'path';
import { saveData, loadData } from './utils.js';
import config from '../config.js';

export async function exportTheme(sourceClient, logger) {
    logger.section('Exporting Theme Files');

    // Get themes list
    const themesRes = await sourceClient.rest('GET', '/themes.json');
    const themes = themesRes?.themes || [];
    const mainTheme = themes.find(t => t.role === 'main');

    if (!mainTheme) {
        logger.error('No main theme found!');
        return null;
    }

    logger.info(`Main theme: "${mainTheme.name}" (ID: ${mainTheme.id})`);

    // Get all theme assets
    const assetsRes = await sourceClient.rest('GET', `/themes/${mainTheme.id}/assets.json`);
    const assetList = assetsRes?.assets || [];
    logger.info(`Found ${assetList.length} theme assets`);

    const themeData = {
        theme: {
            name: mainTheme.name,
            role: mainTheme.role,
        },
        assets: [],
    };

    // Download each asset
    for (const asset of assetList) {
        try {
            const assetRes = await sourceClient.rest(
                'GET',
                `/themes/${mainTheme.id}/assets.json?asset[key]=${encodeURIComponent(asset.key)}`
            );
            const assetDetail = assetRes?.asset;
            if (assetDetail) {
                themeData.assets.push({
                    key: assetDetail.key,
                    value: assetDetail.value || null,
                    attachment: assetDetail.attachment || null,
                    content_type: assetDetail.content_type,
                });

                // Also save to filesystem for inspection
                const assetDir = join(config.dataDir, 'theme', ...asset.key.split('/').slice(0, -1));
                await fs.mkdir(assetDir, { recursive: true });
                const fileName = asset.key.split('/').pop();

                if (assetDetail.value) {
                    await fs.writeFile(join(assetDir, fileName), assetDetail.value, 'utf-8');
                } else if (assetDetail.attachment) {
                    await fs.writeFile(join(assetDir, fileName), assetDetail.attachment, 'base64');
                }
            }
        } catch (err) {
            logger.warn(`Could not download asset ${asset.key}: ${err.message}`);
        }
    }

    await saveData('theme-meta', {
        theme: themeData.theme,
        assetCount: themeData.assets.length,
        assetKeys: themeData.assets.map(a => a.key),
    });

    // Save full theme data separately (can be large)
    await fs.mkdir(join(config.dataDir, 'theme-data'), { recursive: true });
    await fs.writeFile(
        join(config.dataDir, 'theme-data', 'full-theme.json'),
        JSON.stringify(themeData, null, 2)
    );

    logger.success(`Exported ${themeData.assets.length} theme files`);

    // Log sections
    const sections = themeData.assets.filter(a => a.key.startsWith('sections/'));
    const templates = themeData.assets.filter(a => a.key.startsWith('templates/'));
    const snippets = themeData.assets.filter(a => a.key.startsWith('snippets/'));
    const localeFiles = themeData.assets.filter(a => a.key.startsWith('locales/'));

    logger.info(`  Sections: ${sections.length}`);
    logger.info(`  Templates: ${templates.length}`);
    logger.info(`  Snippets: ${snippets.length}`);
    logger.info(`  Locales: ${localeFiles.length}`);

    return themeData;
}

export async function importTheme(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Theme Files');

    let themeData;
    try {
        const raw = await fs.readFile(join(config.dataDir, 'theme-data', 'full-theme.json'), 'utf-8');
        themeData = JSON.parse(raw);
    } catch {
        logger.warn('No theme data found. Run export first.');
        return 0;
    }

    if (dryRun) {
        logger.info(`[DRY RUN] Would import theme "${themeData.theme.name}" with ${themeData.assets.length} assets`);
        return themeData.assets.length;
    }

    // Get or create target theme
    const themesRes = await targetClient.rest('GET', '/themes.json');
    const themes = themesRes?.themes || [];
    let targetTheme = themes.find(t => t.role === 'main');

    // You usually can't create a new "main" theme via API,
    // so we upload to the existing main theme
    if (!targetTheme) {
        logger.error('No main theme found on target store! Please create a theme first.');
        return 0;
    }

    logger.info(`Target theme: "${targetTheme.name}" (ID: ${targetTheme.id})`);

    // ─── Step 1: Delete ALL old theme files (full theme replacement) ───
    logger.info('Cleaning old theme files from target store...');

    const existingAssetsRes = await targetClient.rest('GET', `/themes/${targetTheme.id}/assets.json`);
    const existingAssets = existingAssetsRes?.assets || [];
    const sourceKeys = new Set(themeData.assets.map(a => a.key));

    // These files are protected by Shopify and cannot be deleted
    const PROTECTED_FILES = new Set([
        'layout/theme.liquid',
        'config/settings_schema.json',
    ]);

    // Delete existing files that are NOT in our source theme
    // Also delete files that exist in both (they'll be overwritten anyway, but cleanup first)
    const filesToDelete = existingAssets.filter(a =>
        !PROTECTED_FILES.has(a.key) && !sourceKeys.has(a.key)
    );

    let deleted = 0;
    for (const asset of filesToDelete) {
        try {
            await targetClient.rest(
                'DELETE',
                `/themes/${targetTheme.id}/assets.json?asset[key]=${encodeURIComponent(asset.key)}`
            );
            deleted++;
            logger.debug(`  Deleted old file: ${asset.key}`);
        } catch (err) {
            // Some files may be protected or required — skip silently
            logger.debug(`  Could not delete ${asset.key}: ${err.message}`);
        }
    }

    logger.info(`Deleted ${deleted}/${filesToDelete.length} old theme files (${existingAssets.length} total existed)`);

    // ─── Step 2: Upload new theme files in correct order ───
    logger.info('Uploading new theme files...');

    let imported = 0;
    const failedAssets = [];

    // Upload assets in order: config first, then layout, sections, snippets, templates, locales, assets
    const order = ['config/', 'layout/', 'sections/', 'snippets/', 'templates/', 'locales/', 'assets/'];
    const sortedAssets = [...themeData.assets].sort((a, b) => {
        const aIdx = order.findIndex(prefix => a.key.startsWith(prefix));
        const bIdx = order.findIndex(prefix => b.key.startsWith(prefix));
        return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    });

    for (const asset of sortedAssets) {
        try {
            const payload = { asset: { key: asset.key } };
            if (asset.value) {
                payload.asset.value = asset.value;
            } else if (asset.attachment) {
                payload.asset.attachment = asset.attachment;
            } else {
                continue;
            }

            await targetClient.rest('PUT', `/themes/${targetTheme.id}/assets.json`, payload);
            imported++;

            if (asset.key.startsWith('sections/')) {
                logger.success(`  Uploaded section: ${asset.key}`);
            } else if (asset.key.startsWith('templates/')) {
                logger.success(`  Uploaded template: ${asset.key}`);
            }
        } catch (err) {
            failedAssets.push(asset.key);
            logger.warn(`Could not upload ${asset.key}: ${err.message}`);
        }
    }

    if (failedAssets.length > 0) {
        logger.warn(`Failed to upload ${failedAssets.length} assets:`);
        for (const key of failedAssets) {
            logger.warn(`  - ${key}`);
        }
    }

    logger.stats('Theme', themeData.assets.length, imported);
    return imported;
}
