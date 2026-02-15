import chalk from 'chalk';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
    constructor(level = 'info') {
        this.level = LEVELS[level] ?? 1;
        this.counts = { exported: 0, imported: 0, errors: 0, skipped: 0 };
    }

    debug(msg, ...args) {
        if (this.level <= 0) console.log(chalk.gray(`  [DEBUG] ${msg}`), ...args);
    }

    info(msg, ...args) {
        if (this.level <= 1) console.log(chalk.blue(`  [INFO] ${msg}`), ...args);
    }

    success(msg, ...args) {
        if (this.level <= 1) console.log(chalk.green(`  ✓ ${msg}`), ...args);
    }

    warn(msg, ...args) {
        if (this.level <= 2) console.log(chalk.yellow(`  ⚠ [WARN] ${msg}`), ...args);
    }

    error(msg, ...args) {
        this.counts.errors++;
        console.error(chalk.red(`  ✗ [ERROR] ${msg}`), ...args);
    }

    section(title) {
        console.log('');
        console.log(chalk.bold.cyan(`━━━ ${title} ━━━`));
    }

    stats(moduleName, exported, imported) {
        this.counts.exported += exported;
        this.counts.imported += imported;
        console.log(
            chalk.dim(`  📊 ${moduleName}: exported=${exported}, imported=${imported}`)
        );
    }

    summary() {
        console.log('');
        console.log(chalk.bold('═══ Migration Summary ═══'));
        console.log(chalk.green(`  Total exported: ${this.counts.exported}`));
        console.log(chalk.green(`  Total imported: ${this.counts.imported}`));
        if (this.counts.errors > 0) {
            console.log(chalk.red(`  Errors: ${this.counts.errors}`));
        }
        if (this.counts.skipped > 0) {
            console.log(chalk.yellow(`  Skipped: ${this.counts.skipped}`));
        }
    }
}

export default Logger;
