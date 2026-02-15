import { saveData, loadData } from './utils.js';

export async function exportCustomers(sourceClient, logger) {
    logger.section('Exporting Customers');
    const customers = await sourceClient.restGetAll('/customers.json', 'customers');

    // Get metafields for each customer
    for (const customer of customers) {
        try {
            const mfs = await sourceClient.restGetAll(
                `/customers/${customer.id}/metafields.json`,
                'metafields'
            );
            customer._metafields = mfs;
        } catch {
            customer._metafields = [];
        }
    }

    await saveData('customers', customers);
    logger.success(`Exported ${customers.length} customers`);
    return customers;
}

export async function importCustomers(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Customers');
    const customers = await loadData('customers');
    if (!customers) {
        logger.warn('No customers data found. Run export first.');
        return 0;
    }

    let imported = 0;
    for (const customer of customers) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create customer: ${customer.email}`);
            imported++;
            continue;
        }
        try {
            const payload = {
                customer: {
                    first_name: customer.first_name,
                    last_name: customer.last_name,
                    email: customer.email,
                    phone: customer.phone,
                    tags: customer.tags,
                    note: customer.note,
                    tax_exempt: customer.tax_exempt,
                    verified_email: true,
                    send_email_invite: false,
                    addresses: (customer.addresses || []).map(addr => ({
                        first_name: addr.first_name,
                        last_name: addr.last_name,
                        company: addr.company,
                        address1: addr.address1,
                        address2: addr.address2,
                        city: addr.city,
                        province: addr.province,
                        country: addr.country,
                        zip: addr.zip,
                        phone: addr.phone,
                        default: addr.default,
                    })),
                    metafields: (customer._metafields || []).map(mf => ({
                        namespace: mf.namespace,
                        key: mf.key,
                        value: mf.value,
                        type: mf.type,
                    })),
                },
            };

            const result = await targetClient.rest('POST', '/customers.json', payload);
            if (result?.customer) {
                idMapper.set('customers', String(customer.id), String(result.customer.id));
                imported++;
                logger.success(`Created customer: ${customer.email}`);
            }
        } catch (err) {
            // Email already exists is common
            if (err.message?.includes('already exists') || err.message?.includes('taken')) {
                logger.info(`Customer ${customer.email} already exists, skipping`);
            } else {
                logger.error(`Failed to create customer "${customer.email}": ${err.message}`);
            }
        }
    }

    logger.stats('Customers', customers.length, imported);
    return imported;
}
