#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import config, { validateConfig, validateSourceConfig, validateTargetConfig, resolveTokens } from './config.js';
import ApiClient from './api-client.js';
import IdMapper from './id-mapper.js';
import Logger from './logger.js';

import { exportCollections, importCollections } from './modules/collections.js';
import { exportPages, importPages } from './modules/pages.js';
import { exportBlogs, importBlogs } from './modules/blogs.js';
import { exportMenus, importMenus } from './modules/menus.js';
import { exportMetafields, importMetafields } from './modules/metafields.js';
import { exportMetaobjects, importMetaobjects } from './modules/metaobjects.js';
import { exportTranslations, importTranslations } from './modules/translations.js';
import { exportTheme, importTheme } from './modules/theme.js';
import { exportCustomers, importCustomers } from './modules/customers.js';
import { exportRedirects, importRedirects } from './modules/redirects.js';
import { exportFiles, importFiles } from './modules/files.js';
import { exportDiscounts, importDiscounts } from './modules/discounts.js';
import { exportShopSettings, importShopSettings } from './modules/shop-settings.js';

// ─── Module registry in migration order ──────────────────
const MODULES = [
    { name: 'theme', export: exportTheme, import: importTheme },
    { name: 'collections', export: exportCollections, import: importCollections },
    { name: 'pages', export: exportPages, import: importPages },
    { name: 'blogs', export: exportBlogs, import: importBlogs },
    { name: 'menus', export: exportMenus, import: importMenus },
    { name: 'metafields', export: exportMetafields, import: importMetafields },
    { name: 'metaobjects', export: exportMetaobjects, import: importMetaobjects },
    { name: 'customers', export: exportCustomers, import: importCustomers },
    { name: 'files', export: exportFiles, import: importFiles },
    { name: 'redirects', export: exportRedirects, import: importRedirects },
    { name: 'discounts', export: exportDiscounts, import: importDiscounts },
    { name: 'shop-settings', export: exportShopSettings, import: importShopSettings },
    { name: 'translations', export: exportTranslations, import: importTranslations },
];

const ALL_MODULE_NAMES = MODULES.map(m => m.name);

function filterModules(only, exclude) {
    let modules = [...MODULES];
    if (only) {
        const selected = only.split(',').map(s => s.trim());
        modules = modules.filter(m => selected.includes(m.name));
    }
    if (exclude) {
        const excluded = exclude.split(',').map(s => s.trim());
        modules = modules.filter(m => !excluded.includes(m.name));
    }
    return modules;
}

function printBanner() {
    console.log('');
    console.log(chalk.bold.magenta('╔══════════════════════════════════════════╗'));
    console.log(chalk.bold.magenta('║    🛒 Shopify Store Migration Tool      ║'));
    console.log(chalk.bold.magenta('╚══════════════════════════════════════════╝'));
    console.log('');
}

// ─── Commands ─────────────────────────────────────────────
const program = new Command();

program
    .name('shopify-migrate')
    .description('Complete Shopify store migration tool')
    .version('1.0.0');

program
    .command('export')
    .description('Export all data from source store')
    .option('--only <modules>', `Only export specific modules (${ALL_MODULE_NAMES.join(',')})`)
    .option('--exclude <modules>', 'Exclude specific modules')
    .action(async (opts) => {
        printBanner();
        validateSourceConfig();
        await resolveTokens();

        const logger = new Logger(config.logLevel);
        const sourceClient = new ApiClient(config.source, logger);

        console.log(chalk.cyan(`Source store: ${config.source.shop}`));
        console.log(chalk.cyan(`Data directory: ${config.dataDir}`));
        console.log('');

        const modules = filterModules(opts.only, opts.exclude);
        logger.info(`Exporting ${modules.length} modules: ${modules.map(m => m.name).join(', ')}`);

        for (const mod of modules) {
            const spinner = ora(`Exporting ${mod.name}...`).start();
            try {
                await mod.export(sourceClient, logger);
                spinner.succeed(`${mod.name} exported`);
            } catch (err) {
                spinner.fail(`${mod.name} failed: ${err.message}`);
                logger.error(err.stack);
            }
        }

        logger.summary();
        console.log('');
        console.log(chalk.green.bold('✅ Export complete! Data saved to: ' + config.dataDir));
        console.log(chalk.dim('Run "node src/index.js import" to import to target store'));
    });

program
    .command('import')
    .description('Import data to target store')
    .option('--only <modules>', `Only import specific modules (${ALL_MODULE_NAMES.join(',')})`)
    .option('--exclude <modules>', 'Exclude specific modules')
    .option('--dry-run', 'Show what would be imported without making changes')
    .option('--resume', 'Resume from previous run using saved ID mapping')
    .action(async (opts) => {
        printBanner();
        validateTargetConfig();
        await resolveTokens();

        const logger = new Logger(config.logLevel);
        const targetClient = new ApiClient(config.target, logger);
        const idMapper = new IdMapper();

        if (opts.resume) {
            const loaded = await idMapper.load();
            if (loaded) {
                logger.info('Loaded ID mapping from previous run');
            } else {
                logger.warn('No previous ID mapping found, starting fresh');
            }
        }

        console.log(chalk.cyan(`Target store: ${config.target.shop}`));
        if (opts.dryRun) {
            console.log(chalk.yellow('🔍 DRY RUN MODE - no changes will be made'));
        }
        console.log('');

        const modules = filterModules(opts.only, opts.exclude);
        logger.info(`Importing ${modules.length} modules: ${modules.map(m => m.name).join(', ')}`);

        for (const mod of modules) {
            const spinner = ora(`Importing ${mod.name}...`).start();
            try {
                await mod.import(targetClient, idMapper, logger, opts.dryRun);
                spinner.succeed(`${mod.name} imported`);
            } catch (err) {
                spinner.fail(`${mod.name} failed: ${err.message}`);
                logger.error(err.stack);
            }

            // Save ID mapping after each module
            if (!opts.dryRun) {
                await idMapper.save();
            }
        }

        logger.summary();

        if (!opts.dryRun) {
            await idMapper.save();
            console.log('');
            console.log(chalk.green.bold('✅ Import complete!'));
            console.log(chalk.dim('ID mapping saved to: ' + config.dataDir + '/id-mapping.json'));
            console.log(chalk.dim('Run "node src/index.js verify" to validate the migration'));
        }
    });

program
    .command('migrate')
    .description('Full migration: export from source → import to target')
    .option('--only <modules>', 'Only migrate specific modules')
    .option('--exclude <modules>', 'Exclude specific modules')
    .option('--dry-run', 'Show what would be done without making changes')
    .action(async (opts) => {
        printBanner();
        validateConfig();
        await resolveTokens();

        const logger = new Logger(config.logLevel);
        const sourceClient = new ApiClient(config.source, logger);
        const targetClient = new ApiClient(config.target, logger);
        const idMapper = new IdMapper();

        console.log(chalk.cyan(`Source: ${config.source.shop}`));
        console.log(chalk.cyan(`Target: ${config.target.shop}`));
        if (opts.dryRun) {
            console.log(chalk.yellow('🔍 DRY RUN MODE'));
        }
        console.log('');

        const modules = filterModules(opts.only, opts.exclude);

        // Phase 1: Export
        console.log(chalk.bold.yellow('\n═══ Phase 1: EXPORT ═══\n'));
        for (const mod of modules) {
            const spinner = ora(`Exporting ${mod.name}...`).start();
            try {
                await mod.export(sourceClient, logger);
                spinner.succeed(`${mod.name} exported`);
            } catch (err) {
                spinner.fail(`${mod.name} export failed: ${err.message}`);
            }
        }

        // Phase 2: Import
        console.log(chalk.bold.yellow('\n═══ Phase 2: IMPORT ═══\n'));
        for (const mod of modules) {
            const spinner = ora(`Importing ${mod.name}...`).start();
            try {
                await mod.import(targetClient, idMapper, logger, opts.dryRun);
                spinner.succeed(`${mod.name} imported`);
            } catch (err) {
                spinner.fail(`${mod.name} import failed: ${err.message}`);
            }
            if (!opts.dryRun) await idMapper.save();
        }

        logger.summary();
        if (!opts.dryRun) {
            await idMapper.save();
        }
        console.log(chalk.green.bold('\n✅ Migration complete!'));
    });

program
    .command('verify')
    .description('Verify migration by comparing resource counts')
    .action(async () => {
        printBanner();
        validateConfig();
        await resolveTokens();

        const logger = new Logger(config.logLevel);
        const sourceClient = new ApiClient(config.source, logger);
        const targetClient = new ApiClient(config.target, logger);

        console.log(chalk.bold('Comparing resource counts...\n'));

        const checks = [
            { name: 'Collections', endpoint: '/custom_collections/count.json', key: 'count' },
            { name: 'Smart Col.', endpoint: '/smart_collections/count.json', key: 'count' },
            { name: 'Pages', endpoint: '/pages/count.json', key: 'count' },
            { name: 'Customers', endpoint: '/customers/count.json', key: 'count' },
            { name: 'Redirects', endpoint: '/redirects/count.json', key: 'count' },
        ];

        console.log(chalk.dim('Resource            Source    Target    Match'));
        console.log(chalk.dim('─'.repeat(55)));

        for (const check of checks) {
            try {
                const [sourceRes, targetRes] = await Promise.all([
                    sourceClient.rest('GET', check.endpoint),
                    targetClient.rest('GET', check.endpoint),
                ]);

                const sourceCount = sourceRes?.[check.key] ?? '?';
                const targetCount = targetRes?.[check.key] ?? '?';
                const match = sourceCount === targetCount;

                const status = match
                    ? chalk.green('✓')
                    : chalk.red('✗');

                const name = check.name.padEnd(20);
                const src = String(sourceCount).padStart(6);
                const tgt = String(targetCount).padStart(6);

                console.log(`${status} ${name} ${src}    ${tgt}    ${match ? chalk.green('OK') : chalk.red('MISMATCH')}`);
            } catch (err) {
                console.log(`${chalk.yellow('?')} ${check.name.padEnd(20)} ${chalk.dim('Error: ' + err.message)}`);
            }
        }

        // Check theme assets
        try {
            const sourceThemes = await sourceClient.rest('GET', '/themes.json');
            const targetThemes = await targetClient.rest('GET', '/themes.json');
            const sourceMain = sourceThemes?.themes?.find(t => t.role === 'main');
            const targetMain = targetThemes?.themes?.find(t => t.role === 'main');

            if (sourceMain && targetMain) {
                const sourceAssets = await sourceClient.rest('GET', `/themes/${sourceMain.id}/assets.json`);
                const targetAssets = await targetClient.rest('GET', `/themes/${targetMain.id}/assets.json`);
                const sc = sourceAssets?.assets?.length ?? '?';
                const tc = targetAssets?.assets?.length ?? '?';
                const match = sc === tc;
                console.log(`${match ? chalk.green('✓') : chalk.red('✗')} ${'Theme assets'.padEnd(20)} ${String(sc).padStart(6)}    ${String(tc).padStart(6)}    ${match ? chalk.green('OK') : chalk.red('MISMATCH')}`);
            }
        } catch (err) {
            console.log(`${chalk.yellow('?')} ${'Theme assets'.padEnd(20)} ${chalk.dim('Error')}`);
        }

        console.log('');
    });

program
    .command('list')
    .description('List available modules')
    .action(() => {
        printBanner();
        console.log(chalk.bold('Available modules:\n'));
        for (const mod of MODULES) {
            console.log(`  ${chalk.cyan('•')} ${mod.name}`);
        }
        console.log('');
        console.log(chalk.dim('Use --only or --exclude to filter modules'));
        console.log(chalk.dim('Example: node src/index.js migrate --only collections,pages'));
    });

program.parse();
