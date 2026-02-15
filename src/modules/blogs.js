import { saveData, loadData } from './utils.js';

export async function exportBlogs(sourceClient, logger) {
    logger.section('Exporting Blogs & Articles');
    const blogs = await sourceClient.restGetAll('/blogs.json', 'blogs');

    for (const blog of blogs) {
        try {
            const articles = await sourceClient.restGetAll(
                `/blogs/${blog.id}/articles.json`,
                'articles'
            );
            // Get metafields for each article
            for (const article of articles) {
                try {
                    const mfs = await sourceClient.restGetAll(
                        `/articles/${article.id}/metafields.json`,
                        'metafields'
                    );
                    article._metafields = mfs;
                } catch {
                    article._metafields = [];
                }
            }
            blog._articles = articles;
        } catch (err) {
            logger.warn(`Could not get articles for blog ${blog.id}: ${err.message}`);
            blog._articles = [];
        }
    }

    await saveData('blogs', blogs);
    logger.success(`Exported ${blogs.length} blogs with articles`);
    return blogs;
}

export async function importBlogs(targetClient, idMapper, logger, dryRun = false) {
    logger.section('Importing Blogs & Articles');
    const blogs = await loadData('blogs');
    if (!blogs) {
        logger.warn('No blogs data found. Run export first.');
        return 0;
    }

    let imported = 0;
    for (const blog of blogs) {
        if (dryRun) {
            logger.info(`[DRY RUN] Would create blog: ${blog.title} with ${blog._articles?.length || 0} articles`);
            imported++;
            continue;
        }
        try {
            const blogPayload = {
                blog: {
                    title: blog.title,
                    handle: blog.handle,
                    commentable: blog.commentable,
                    template_suffix: blog.template_suffix || '',
                },
            };

            const result = await targetClient.rest('POST', '/blogs.json', blogPayload);
            if (result?.blog) {
                const targetBlogId = result.blog.id;
                idMapper.set('blogs', String(blog.id), String(targetBlogId));
                imported++;
                logger.success(`Created blog: ${blog.title}`);

                // Import articles
                for (const article of blog._articles || []) {
                    try {
                        const articlePayload = {
                            article: {
                                title: article.title,
                                handle: article.handle,
                                author: article.author,
                                body_html: article.body_html,
                                summary_html: article.summary_html,
                                tags: article.tags,
                                published: article.published_at ? true : false,
                                published_at: article.published_at,
                                template_suffix: article.template_suffix || '',
                                image: article.image ? { src: article.image.src, alt: article.image.alt || '' } : undefined,
                                metafields: (article._metafields || []).map(mf => ({
                                    namespace: mf.namespace,
                                    key: mf.key,
                                    value: mf.value,
                                    type: mf.type,
                                })),
                            },
                        };

                        const artResult = await targetClient.rest(
                            'POST',
                            `/blogs/${targetBlogId}/articles.json`,
                            articlePayload
                        );
                        if (artResult?.article) {
                            idMapper.set('articles', String(article.id), String(artResult.article.id));
                            logger.success(`  Created article: ${article.title}`);
                        }
                    } catch (err) {
                        logger.error(`  Failed to create article "${article.title}": ${err.message}`);
                    }
                }
            }
        } catch (err) {
            logger.error(`Failed to create blog "${blog.title}": ${err.message}`);
        }
    }

    logger.stats('Blogs', blogs.length, imported);
    return imported;
}
