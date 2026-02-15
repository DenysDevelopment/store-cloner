import { saveData, loadData, extractId } from './utils.js';

const EXPORT_QUERY = `
  query Products($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          title
          descriptionHtml
          handle
          productType
          vendor
          tags
          status
          templateSuffix
          seo { title description }
          options { name values }
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                compareAtPrice
                barcode
                inventoryQuantity
                inventoryPolicy
                taxable
                selectedOptions { name value }
                image { url altText }
                inventoryItem {
                  measurement {
                    weight { unit value }
                  }
                  requiresShipping
                }
              }
            }
          }
          images(first: 250) {
            edges {
              node { id url altText }
            }
          }
          metafields(first: 100) {
            edges {
              node {
                namespace
                key
                value
                type
              }
            }
          }
        }
      }
    }
  }
`;

export async function exportProducts(sourceClient, logger) {
  logger.section('Exporting Products');
  const products = await sourceClient.graphqlAll(EXPORT_QUERY, {}, 'products');
  logger.success(`Exported ${products.length} products`);
  await saveData('products', products);
  return products;
}

export async function importProducts(targetClient, idMapper, logger, dryRun = false) {
  logger.section('Importing Products');
  const products = await loadData('products');
  if (!products) {
    logger.warn('No products data found. Run export first.');
    return 0;
  }

  let imported = 0;
  for (const product of products) {
    if (dryRun) {
      logger.info(`[DRY RUN] Would create product: ${product.title}`);
      imported++;
      continue;
    }

    try {
      const variants = (product.variants?.edges || []).map(e => e.node);
      const images = (product.images?.edges || []).map(e => e.node);
      const metafields = (product.metafields?.edges || []).map(e => e.node);

      // Use REST for product creation — more straightforward for full data
      const productData = {
        product: {
          title: product.title,
          body_html: product.descriptionHtml,
          handle: product.handle,
          product_type: product.productType,
          vendor: product.vendor,
          tags: (product.tags || []).join(', '),
          status: product.status?.toLowerCase() || 'active',
          template_suffix: product.templateSuffix || '',
          metafields_global_title_tag: product.seo?.title || '',
          metafields_global_description_tag: product.seo?.description || '',
          options: (product.options || []).map(o => ({
            name: o.name,
            values: o.values,
          })),
          variants: variants.map(v => ({
            title: v.title,
            sku: v.sku || '',
            price: v.price,
            compare_at_price: v.compareAtPrice,
            barcode: v.barcode || '',
            weight: v.inventoryItem?.measurement?.weight?.value || 0,
            weight_unit: (v.inventoryItem?.measurement?.weight?.unit || 'KILOGRAMS').toLowerCase().replace('kilograms', 'kg').replace('grams', 'g').replace('pounds', 'lb').replace('ounces', 'oz'),
            inventory_policy: v.inventoryPolicy?.toLowerCase() || 'deny',
            taxable: v.taxable,
            requires_shipping: v.inventoryItem?.requiresShipping ?? true,
            option1: v.selectedOptions?.[0]?.value,
            option2: v.selectedOptions?.[1]?.value,
            option3: v.selectedOptions?.[2]?.value,
          })),
          images: images.map(img => ({
            src: img.url,
            alt: img.altText || '',
          })),
          metafields: metafields.map(mf => ({
            namespace: mf.namespace,
            key: mf.key,
            value: mf.value,
            type: mf.type,
          })),
        },
      };

      const result = await targetClient.rest('POST', '/products.json', productData);
      if (result?.product) {
        const sourceId = extractId(product.id);
        const targetId = String(result.product.id);
        idMapper.set('products', sourceId, targetId);
        idMapper.setHandleMap('products', product.handle, sourceId, targetId);

        // Map variant IDs too
        const sourceVariants = variants;
        const targetVariants = result.product.variants || [];
        for (let i = 0; i < Math.min(sourceVariants.length, targetVariants.length); i++) {
          const sVarId = extractId(sourceVariants[i].id);
          idMapper.set('variants', sVarId, String(targetVariants[i].id));
        }
        // Map image IDs
        const targetImages = result.product.images || [];
        for (let i = 0; i < Math.min(images.length, targetImages.length); i++) {
          const sImgId = extractId(images[i].id);
          idMapper.set('images', sImgId, String(targetImages[i].id));
        }

        imported++;
        logger.success(`Created product: ${product.title} (${targetId})`);
      }
    } catch (err) {
      logger.error(`Failed to create product "${product.title}": ${err.message}`);
    }
  }

  logger.stats('Products', products.length, imported);
  return imported;
}
