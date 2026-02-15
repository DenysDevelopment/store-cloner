import { saveData, loadData, extractId } from './utils.js';

const FILES_QUERY = `
  query Files($cursor: String) {
    files(first: 50, after: $cursor) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          ... on MediaImage {
            id
            alt
            image { url }
            mimeType
          }
          ... on Video {
            id
            alt
            sources { url mimeType }
          }
          ... on GenericFile {
            id
            alt
            url
            mimeType
          }
        }
      }
    }
  }
`;

export async function exportFiles(sourceClient, logger) {
    logger.section('Exporting Files');
    const files = await sourceClient.graphqlAll(FILES_QUERY, {}, 'files');
    await saveData('files', files);
    logger.success(`Exported ${files.length} files`);
    return files;
}

export async function importFiles(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Files');
    const files = await loadData('files');
    if (!files) {
        logger.warn('No files data found. Run export first.');
        return 0;
    }

    let imported = 0;
    for (const file of files) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would upload file: ${file.id}`);
            imported++;
            continue;
        }

        try {
            let url = null;
            let filename = 'file';

            if (file.image?.url) {
                url = file.image.url;
                filename = url.split('/').pop()?.split('?')[0] || 'image';
            } else if (file.sources?.[0]?.url) {
                url = file.sources[0].url;
                filename = url.split('/').pop()?.split('?')[0] || 'video';
            } else if (file.url) {
                url = file.url;
                filename = url.split('/').pop()?.split('?')[0] || 'file';
            }

            if (!url) {
                logger.debug(`No URL for file ${file.id}, skipping`);
                continue;
            }

            const mutation = `
        mutation FileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files { id }
            userErrors { field message }
          }
        }
      `;

            const result = await targetClient.graphql(mutation, {
                files: [{
                    originalSource: url,
                    alt: file.alt || '',
                    contentType: file.mimeType?.startsWith('image') ? 'IMAGE' :
                        file.mimeType?.startsWith('video') ? 'VIDEO' : 'FILE',
                }],
            });

            if (result?.fileCreate?.files?.[0]) {
                idMapper.set('files', extractId(file.id), extractId(result.fileCreate.files[0].id));
                imported++;
            } else if (result?.fileCreate?.userErrors?.length > 0) {
                logger.warn(`File upload errors: ${JSON.stringify(result.fileCreate.userErrors)}`);
            }
        } catch (err) {
            logger.error(`Failed to upload file: ${err.message}`);
        }
    }

    logger.stats('Files', files.length, imported);
    return imported;
}
