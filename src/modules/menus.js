import { saveData, loadData, extractId } from './utils.js';

const MENUS_QUERY = `
  query Menus($cursor: String) {
    menus(first: 50, after: $cursor) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          title
          handle
          items {
            id
            title
            type
            url
            resourceId
            items {
              id
              title
              type
              url
              resourceId
              items {
                id
                title
                type
                url
                resourceId
              }
            }
          }
        }
      }
    }
  }
`;

export async function exportMenus(sourceClient, logger) {
    logger.section('Exporting Menus');
    const menus = await sourceClient.graphqlAll(MENUS_QUERY, {}, 'menus');
    await saveData('menus', menus);
    logger.success(`Exported ${menus.length} menus`);
    return menus;
}

function remapMenuItems(items, idMapper) {
    return (items || []).map(item => {
        const mapped = {
            title: item.title,
            type: item.type,
            url: item.url || '',
        };

        // Try to remap resource IDs
        if (item.resourceId) {
            const sourceId = extractId(item.resourceId);
            if (item.resourceId.includes('Product')) {
                const targetId = idMapper.get('products', sourceId);
                if (targetId) mapped.resourceId = `gid://shopify/Product/${targetId}`;
            } else if (item.resourceId.includes('Collection')) {
                const targetId = idMapper.get('collections', sourceId);
                if (targetId) mapped.resourceId = `gid://shopify/Collection/${targetId}`;
            } else if (item.resourceId.includes('Page')) {
                const targetId = idMapper.get('pages', sourceId);
                if (targetId) mapped.resourceId = `gid://shopify/Page/${targetId}`;
            } else if (item.resourceId.includes('Blog')) {
                const targetId = idMapper.get('blogs', sourceId);
                if (targetId) mapped.resourceId = `gid://shopify/Blog/${targetId}`;
            }
        }

        if (item.items && item.items.length > 0) {
            mapped.items = remapMenuItems(item.items, idMapper);
        }

        return mapped;
    });
}

function mapMenuItemIds(sourceItems, targetItems, idMapper, logger) {
    if (!sourceItems || !targetItems) return;
    for (let i = 0; i < Math.min(sourceItems.length, targetItems.length); i++) {
        const sourceId = extractId(sourceItems[i].id);
        const targetId = extractId(targetItems[i].id);
        if (sourceId && targetId) {
            idMapper.set('links', sourceId, targetId);
            logger.debug(`  Mapped link: ${sourceItems[i].title} (${sourceId} → ${targetId})`);
        }
        // Recurse for nested items
        if (sourceItems[i].items && targetItems[i].items) {
            mapMenuItemIds(sourceItems[i].items, targetItems[i].items, idMapper, logger);
        }
    }
}

export async function importMenus(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Menus');
    const menus = await loadData('menus');
    if (!menus) {
        logger.warn('No menus data found. Run export first.');
        return 0;
    }

    let imported = 0;
    for (const menu of menus) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create menu: ${menu.title}`);
            imported++;
            continue;
        }
        try {
            const items = remapMenuItems(menu.items, idMapper);

            const mutation = `
        mutation MenuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
          menuCreate(title: $title, handle: $handle, items: $items) {
            menu {
              id title handle
              items {
                id title
                items {
                  id title
                  items { id title }
                }
              }
            }
            userErrors { field message }
          }
        }
      `;

            const result = await targetClient.graphql(mutation, {
                title: menu.title,
                handle: menu.handle,
                items,
            });

            if (result?.menuCreate?.menu) {
                idMapper.set('menus', extractId(menu.id), extractId(result.menuCreate.menu.id));

                // Map individual menu item (link) IDs for translations
                mapMenuItemIds(menu.items, result.menuCreate.menu.items, idMapper, logger);

                imported++;
                logger.success(`Created menu: ${menu.title}`);
            } else if (result?.menuCreate?.userErrors?.length > 0) {
                logger.error(`Menu "${menu.title}" errors: ${JSON.stringify(result.menuCreate.userErrors)}`);
            }
        } catch (err) {
            logger.error(`Failed to create menu "${menu.title}": ${err.message}`);
        }
    }

    logger.stats('Menus', menus.length, imported);
    return imported;
}
