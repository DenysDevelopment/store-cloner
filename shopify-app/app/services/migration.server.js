// ─── This is the same migration engine as web-server.js but adapted for Shopify App context ───
// Target store auth comes automatically from Shopify session (OAuth)
// Source store auth is provided by the user (token or client credentials)

import PQueue from "p-queue";
import prisma from "../db.server.js";

// ─── API Client ───────────────────────────────────────────

class ApiClient {
    constructor(shop, accessToken) {
        this.shop = shop.replace(/^https?:\/\//, "").replace(/\/$/, "");
        this.accessToken = accessToken;
        this.baseUrl = `https://${this.shop}/admin/api/2025-01`;
        this.graphqlUrl = `https://${this.shop}/admin/api/2025-01/graphql.json`;
        this.queue = new PQueue({ intervalCap: 2, interval: 1000, carryoverConcurrencyCount: true });
    }
    get headers() { return { "Content-Type": "application/json", "X-Shopify-Access-Token": this.accessToken }; }
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async graphql(query, variables = {}) {
        return this.queue.add(async () => {
            for (let a = 1; a <= 3; a++) {
                try {
                    const r = await fetch(this.graphqlUrl, { method: "POST", headers: this.headers, body: JSON.stringify({ query, variables }) });
                    if (r.status === 429) { await this.sleep(parseFloat(r.headers.get("Retry-After") || "2") * 1000); continue; }
                    if (!r.ok) throw new Error(`GraphQL ${r.status}: ${(await r.text()).slice(0, 300)}`);
                    const j = await r.json();
                    if (j.errors?.length) { if (j.errors.find(e => e.message?.includes("Throttled")) && a < 3) { await this.sleep(2000); continue; } throw new Error(JSON.stringify(j.errors).slice(0, 300)); }
                    return j.data;
                } catch (e) { if (a === 3) throw e; await this.sleep(1000 * a); }
            }
        });
    }

    async graphqlAll(query, variables, connectionPath) {
        const results = []; let cursor = null, hasNext = true;
        while (hasNext) {
            const d = await this.graphql(query, { ...variables, cursor });
            let c = d; for (const k of connectionPath.split(".")) c = c?.[k]; if (!c) break;
            for (const e of c.edges || []) results.push(e.node);
            hasNext = c.pageInfo?.hasNextPage || false;
            if (hasNext && c.edges?.length) cursor = c.edges[c.edges.length - 1].cursor;
        }
        return results;
    }

    async rest(method, endpoint, body = null) {
        return this.queue.add(async () => {
            for (let a = 1; a <= 3; a++) {
                try {
                    const opts = { method, headers: this.headers }; if (body) opts.body = JSON.stringify(body);
                    const r = await fetch(`${this.baseUrl}${endpoint}`, opts);
                    if (r.status === 429) { await this.sleep(parseFloat(r.headers.get("Retry-After") || "2") * 1000); continue; }
                    if (r.status === 404) return null; if (!r.ok) throw new Error(`REST ${method} ${endpoint} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
                    if (r.status === 204) return {}; return await r.json();
                } catch (e) { if (a === 3) throw e; await this.sleep(1000 * a); }
            }
        });
    }

    async restGetAll(endpoint, resourceKey) {
        const results = []; let url = `${endpoint}?limit=250`;
        while (url) {
            const r = await this.queue.add(async () => {
                const res = await fetch(`${this.baseUrl}${url}`, { headers: this.headers });
                if (res.status === 429) { await this.sleep(2000); return { data: { [resourceKey]: [] }, nextUrl: url }; }
                if (!res.ok) throw new Error(`REST GET ${url} → ${res.status}`);
                const data = await res.json(); const link = res.headers.get("Link"); let nextUrl = null;
                if (link) { const m = link.match(/<([^>]+)>;\s*rel="next"/); if (m) { const u = new URL(m[1]); nextUrl = u.pathname.replace("/admin/api/2025-01", "") + u.search; } }
                return { data, nextUrl };
            });
            results.push(...(r.data[resourceKey] || [])); url = r.nextUrl;
        }
        return results;
    }
}

// ─── Helpers ──────────────────────────────────────────────

class IdMapper {
    constructor() { this.map = {}; this.handleMap = {}; }
    set(t, s, d) { if (!this.map[t]) this.map[t] = {}; this.map[t][String(s)] = String(d); }
    get(t, s) { return this.map[t]?.[String(s)] || null; }
    setHandleMap(t, h, s, d) { if (!this.handleMap[t]) this.handleMap[t] = {}; this.handleMap[t][h] = { sourceId: String(s), targetId: String(d) }; }
}

function extractId(gid) { if (!gid) return null; const m = String(gid).match(/\/(\d+)$/); return m ? m[1] : gid; }
function buildGid(t, id) { return `gid://shopify/${t}/${id}`; }

// ─── Module list ──────────────────────────────────────────

export const ALL_MODULES = [
    { name: "theme", label: "Theme" },
    { name: "collections", label: "Collections" },
    { name: "pages", label: "Pages" },
    { name: "blogs", label: "Blogs & Articles" },
    { name: "menus", label: "Navigation" },
    { name: "metafields", label: "Metafields" },
    { name: "metaobjects", label: "Metaobjects" },
    { name: "customers", label: "Customers" },
    { name: "files", label: "Media files" },
    { name: "redirects", label: "URL redirects" },
    { name: "discounts", label: "Discounts" },
    { name: "shop-settings", label: "Settings & locales" },
    { name: "translations", label: "Translations" },
];

// ─── Resolve source token ─────────────────────────────────

export async function resolveSourceToken(shop, token, clientId, clientSecret) {
    if (token) return token;
    if (!clientId || !clientSecret) throw new Error("Provide access token or client_id + client_secret");
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    });
    if (!r.ok) throw new Error(`OAuth failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    if (!d.access_token) throw new Error("No access_token in response");
    return d.access_token;
}

// ─── Logging ──────────────────────────────────────────────

async function appendLog(jobId, level, message) {
    const job = await prisma.migrationJob.findUnique({ where: { id: jobId }, select: { logs: true } });
    const logs = JSON.parse(job?.logs || "[]");
    logs.push({ time: new Date().toISOString(), level, message });
    await prisma.migrationJob.update({ where: { id: jobId }, data: { logs: JSON.stringify(logs.slice(-500)) } });
}

// ─── Main runner ──────────────────────────────────────────

export async function startMigration(jobId, targetAccessToken) {
    const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error("Job not found");

    const src = new ApiClient(job.sourceShop, job.sourceToken);
    const tgt = new ApiClient(job.shop, targetAccessToken);
    const idMap = new IdMapper();

    const selected = job.modules === "all" ? ALL_MODULES.map(m => m.name) : job.modules.split(",").map(s => s.trim());
    const modules = ALL_MODULES.filter(m => selected.includes(m.name));

    await prisma.migrationJob.update({ where: { id: jobId }, data: { status: "running", totalModules: modules.length } });
    await appendLog(jobId, "info", `Starting: ${modules.map(m => m.name).join(", ")}`);
    await appendLog(jobId, "info", `Source: ${job.sourceShop} → Target: ${job.shop}`);

    let done = 0;
    for (const mod of modules) {
        const cur = await prisma.migrationJob.findUnique({ where: { id: jobId } });
        if (cur?.status === "cancelled") { await appendLog(jobId, "warn", "Cancelled"); return; }

        await prisma.migrationJob.update({ where: { id: jobId }, data: { currentModule: mod.name, progress: Math.round((done / modules.length) * 100) } });
        await appendLog(jobId, "info", `━━━ ${mod.name.toUpperCase()} ━━━`);

        try {
            const data = await EXP[mod.name](src, jobId);
            await IMP[mod.name](tgt, idMap, data, jobId);
            done++;
            await prisma.migrationJob.update({ where: { id: jobId }, data: { doneModules: done, progress: Math.round((done / modules.length) * 100) } });
            await appendLog(jobId, "success", `✓ ${mod.name}`);
        } catch (err) {
            await appendLog(jobId, "error", `✗ ${mod.name}: ${err.message}`);
            done++;
        }
    }

    await prisma.migrationJob.update({ where: { id: jobId }, data: { status: "completed", progress: 100, currentModule: null, completedAt: new Date() } });
    await appendLog(jobId, "success", "🎉 Migration complete!");
}

// ═══════════════════════════════════════════════════════════
// MODULE IMPLEMENTATIONS (same as web-server.js, compact)
// ═══════════════════════════════════════════════════════════

// Theme
async function eTheme(c, j) { const r = await c.rest("GET", "/themes.json"); const m = r?.themes?.find(t => t.role === "main"); if (!m) throw new Error("No main theme"); const assets = []; const list = (await c.rest("GET", `/themes/${m.id}/assets.json`))?.assets || []; for (const a of list) { try { const d = (await c.rest("GET", `/themes/${m.id}/assets.json?asset[key]=${encodeURIComponent(a.key)}`))?.asset; if (d) assets.push({ key: d.key, value: d.value || null, attachment: d.attachment || null }); } catch {} } await appendLog(j, "info", `${assets.length} theme assets`); return { theme: m, assets }; }
async function iTheme(c, _, data, j) { if (!data?.assets) return; const t = (await c.rest("GET", "/themes.json"))?.themes?.find(t => t.role === "main"); if (!t) throw new Error("No target theme"); const order = ["config/", "layout/", "sections/", "snippets/", "templates/", "locales/", "assets/"]; const sorted = [...data.assets].sort((a, b) => { const ai = order.findIndex(p => a.key.startsWith(p)); const bi = order.findIndex(p => b.key.startsWith(p)); return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi); }); let ok = 0; for (const a of sorted) { try { const p = { asset: { key: a.key } }; if (a.value) p.asset.value = a.value; else if (a.attachment) p.asset.attachment = a.attachment; else continue; await c.rest("PUT", `/themes/${t.id}/assets.json`, p); ok++; } catch {} } await appendLog(j, "info", `${ok}/${data.assets.length} assets`); }

// Collections
async function eColl(c, j) { const cu = await c.restGetAll("/custom_collections.json", "custom_collections"); const sm = await c.restGetAll("/smart_collections.json", "smart_collections"); await appendLog(j, "info", `${cu.length} custom + ${sm.length} smart`); return { custom: cu, smart: sm }; }
async function iColl(c, id, data, j) { if (!data) return; let ok = 0; for (const col of data.custom || []) { try { const r = await c.rest("POST", "/custom_collections.json", { custom_collection: { title: col.title, handle: col.handle, body_html: col.body_html, published: col.published, sort_order: col.sort_order, template_suffix: col.template_suffix, image: col.image?.src ? { src: col.image.src, alt: col.image.alt } : undefined } }); if (r?.custom_collection) { id.set("collections", String(col.id), String(r.custom_collection.id)); ok++; } } catch {} } for (const col of data.smart || []) { try { const r = await c.rest("POST", "/smart_collections.json", { smart_collection: { title: col.title, handle: col.handle, body_html: col.body_html, published: col.published, sort_order: col.sort_order, rules: col.rules, disjunctive: col.disjunctive, image: col.image?.src ? { src: col.image.src } : undefined } }); if (r?.smart_collection) { id.set("collections", String(col.id), String(r.smart_collection.id)); ok++; } } catch {} } await appendLog(j, "info", `${ok} collections`); }

// Pages
async function ePages(c, j) { const p = await c.restGetAll("/pages.json", "pages"); await appendLog(j, "info", `${p.length} pages`); return p; }
async function iPages(c, id, data, j) { if (!data) return; let ok = 0; for (const p of data) { try { const r = await c.rest("POST", "/pages.json", { page: { title: p.title, handle: p.handle, body_html: p.body_html, author: p.author, template_suffix: p.template_suffix, published: !!p.published_at } }); if (r?.page) { id.set("pages", String(p.id), String(r.page.id)); ok++; } } catch {} } await appendLog(j, "info", `${ok}/${data.length} pages`); }

// Blogs
async function eBlogs(c, j) { const b = await c.restGetAll("/blogs.json", "blogs"); for (const bl of b) { try { bl._articles = await c.restGetAll(`/blogs/${bl.id}/articles.json`, "articles"); } catch { bl._articles = []; } } await appendLog(j, "info", `${b.length} blogs`); return b; }
async function iBlogs(c, id, data, j) { if (!data) return; let ok = 0; for (const b of data) { try { const r = await c.rest("POST", "/blogs.json", { blog: { title: b.title, handle: b.handle } }); if (r?.blog) { id.set("blogs", String(b.id), String(r.blog.id)); ok++; for (const a of b._articles || []) { try { const ar = await c.rest("POST", `/blogs/${r.blog.id}/articles.json`, { article: { title: a.title, handle: a.handle, author: a.author, body_html: a.body_html, tags: a.tags, published: !!a.published_at, image: a.image?.src ? { src: a.image.src } : undefined } }); if (ar?.article) { id.set("articles", String(a.id), String(ar.article.id)); ok++; } } catch {} } } } catch {} } await appendLog(j, "info", `${ok} blog resources`); }

// Menus
async function eMenus(c, j) { const m = await c.graphqlAll(`query($cursor:String){menus(first:50,after:$cursor){pageInfo{hasNextPage}edges{cursor node{id title handle items{id title type url resourceId items{id title type url resourceId items{id title type url resourceId}}}}}}}`, {}, "menus"); await appendLog(j, "info", `${m.length} menus`); return m; }
function remap(items, id) { return (items || []).map(i => { const m = { title: i.title, type: i.type, url: i.url || "" }; if (i.resourceId) { const s = extractId(i.resourceId); if (i.resourceId.includes("Collection")) { const t = id.get("collections", s); if (t) m.resourceId = `gid://shopify/Collection/${t}`; } else if (i.resourceId.includes("Page")) { const t = id.get("pages", s); if (t) m.resourceId = `gid://shopify/Page/${t}`; } else if (i.resourceId.includes("Blog")) { const t = id.get("blogs", s); if (t) m.resourceId = `gid://shopify/Blog/${t}`; } } if (i.items?.length) m.items = remap(i.items, id); return m; }); }
async function iMenus(c, id, data, j) { if (!data) return; let ok = 0; for (const m of data) { try { const r = await c.graphql(`mutation($t:String!,$h:String!,$i:[MenuItemCreateInput!]!){menuCreate(title:$t,handle:$h,items:$i){menu{id}userErrors{message}}}`, { t: m.title, h: m.handle, i: remap(m.items, id) }); if (r?.menuCreate?.menu) { id.set("menus", extractId(m.id), extractId(r.menuCreate.menu.id)); ok++; } } catch {} } await appendLog(j, "info", `${ok}/${data.length} menus`); }

// Metafields
const MF_OT = ["PRODUCT", "VARIANT", "COLLECTION", "CUSTOMER", "ORDER", "PAGE", "ARTICLE", "BLOG", "SHOP"];
async function eMf(c, j) { const defs = []; for (const ot of MF_OT) { try { const d = await c.graphqlAll(`query($cursor:String,$ot:MetafieldOwnerType!){metafieldDefinitions(first:50,after:$cursor,ownerType:$ot){pageInfo{hasNextPage}edges{cursor node{id name namespace key type{name}description ownerType validations{name value}}}}}`, { ot }, "metafieldDefinitions"); defs.push(...d); } catch {} } let sm = []; try { sm = (await c.rest("GET", "/metafields.json"))?.metafields || []; } catch {} await appendLog(j, "info", `${defs.length} defs + ${sm.length} shop mf`); return { definitions: defs, shopMetafields: sm }; }
async function iMf(c, id, data, j) { if (!data) return; let ok = 0; for (const d of data.definitions || []) { try { const r = await c.graphql(`mutation($d:MetafieldDefinitionInput!){metafieldDefinitionCreate(definition:$d){createdDefinition{id}userErrors{message}}}`, { d: { name: d.name, namespace: d.namespace, key: d.key, type: d.type?.name, description: d.description || "", ownerType: d.ownerType, validations: (d.validations || []).map(v => ({ name: v.name, value: v.value })) } }); if (r?.metafieldDefinitionCreate?.createdDefinition) ok++; } catch {} } for (const m of data.shopMetafields || []) { try { await c.rest("POST", "/metafields.json", { metafield: { namespace: m.namespace, key: m.key, value: m.value, type: m.type } }); ok++; } catch {} } await appendLog(j, "info", `${ok} metafield resources`); }

// Metaobjects
async function eMo(c, j) { const d = await c.graphqlAll(`query($cursor:String){metaobjectDefinitions(first:50,after:$cursor){pageInfo{hasNextPage}edges{cursor node{id name type fieldDefinitions{name key type{name}description required validations{name value}}access{storefront}capabilities{publishable{enabled}translatable{enabled}}}}}}`, {}, "metaobjectDefinitions"); for (const def of d) { try { def._entries = await c.graphqlAll(`query($t:String!,$cursor:String){metaobjects(type:$t,first:50,after:$cursor){pageInfo{hasNextPage}edges{cursor node{id handle type fields{key value type}}}}}`, { t: def.type }, "metaobjects"); } catch { def._entries = []; } } await appendLog(j, "info", `${d.length} defs`); return d; }
async function iMo(c, id, data, j) { if (!data) return; let ok = 0; for (const d of data) { try { await c.graphql(`mutation($d:MetaobjectDefinitionCreateInput!){metaobjectDefinitionCreate(definition:$d){metaobjectDefinition{id}userErrors{message}}}`, { d: { name: d.name, type: d.type, fieldDefinitions: d.fieldDefinitions.map(f => ({ name: f.name, key: f.key, type: f.type?.name, description: f.description || "", required: f.required || false, validations: (f.validations || []).map(v => ({ name: v.name, value: v.value })) })), access: d.access || {}, capabilities: d.capabilities || {} } }); for (const e of d._entries || []) { try { const r = await c.graphql(`mutation($m:MetaobjectCreateInput!){metaobjectCreate(metaobject:$m){metaobject{id}userErrors{message}}}`, { m: { type: d.type, handle: e.handle, fields: (e.fields || []).map(f => ({ key: f.key, value: f.value })) } }); if (r?.metaobjectCreate?.metaobject) { id.set("metaobjects", extractId(e.id), extractId(r.metaobjectCreate.metaobject.id)); ok++; } } catch {} } } catch {} } await appendLog(j, "info", `${ok} metaobject resources`); }

// Customers
async function eCust(c, j) { const d = await c.restGetAll("/customers.json", "customers"); await appendLog(j, "info", `${d.length} customers`); return d; }
async function iCust(c, id, data, j) { if (!data) return; let ok = 0; for (const cu of data) { try { const r = await c.rest("POST", "/customers.json", { customer: { first_name: cu.first_name, last_name: cu.last_name, email: cu.email, phone: cu.phone, tags: cu.tags, note: cu.note, accepts_marketing: cu.accepts_marketing, addresses: (cu.addresses || []).map(a => ({ address1: a.address1, address2: a.address2, city: a.city, province: a.province, zip: a.zip, country: a.country, phone: a.phone, first_name: a.first_name, last_name: a.last_name, default: a.default })), send_email_welcome: false } }); if (r?.customer) { id.set("customers", String(cu.id), String(r.customer.id)); ok++; } } catch {} } await appendLog(j, "info", `${ok}/${data.length} customers`); }

// Files
async function eFiles(c, j) { const f = await c.graphqlAll(`query($cursor:String){files(first:50,after:$cursor){pageInfo{hasNextPage}edges{cursor node{...on MediaImage{id alt image{url}mimeType}...on Video{id alt sources{url mimeType}}...on GenericFile{id alt url mimeType}}}}}`, {}, "files"); await appendLog(j, "info", `${f.length} files`); return f; }
async function iFiles(c, id, data, j) { if (!data) return; let ok = 0; for (const f of data) { try { const url = f.image?.url || f.sources?.[0]?.url || f.url; if (!url) continue; const r = await c.graphql(`mutation($f:[FileCreateInput!]!){fileCreate(files:$f){files{id}userErrors{message}}}`, { f: [{ originalSource: url, alt: f.alt || "", contentType: f.mimeType?.startsWith("image") ? "IMAGE" : f.mimeType?.startsWith("video") ? "VIDEO" : "FILE" }] }); if (r?.fileCreate?.files?.[0]) { id.set("files", extractId(f.id), extractId(r.fileCreate.files[0].id)); ok++; } } catch {} } await appendLog(j, "info", `${ok}/${data.length} files`); }

// Redirects
async function eRedir(c, j) { const r = await c.restGetAll("/redirects.json", "redirects"); await appendLog(j, "info", `${r.length} redirects`); return r; }
async function iRedir(c, _, data, j) { if (!data) return; let ok = 0; for (const r of data) { try { await c.rest("POST", "/redirects.json", { redirect: { path: r.path, target: r.target } }); ok++; } catch {} } await appendLog(j, "info", `${ok}/${data.length} redirects`); }

// Discounts
async function eDisc(c, j) { const p = await c.restGetAll("/price_rules.json", "price_rules"); for (const r of p) { try { r._codes = await c.restGetAll(`/price_rules/${r.id}/discount_codes.json`, "discount_codes"); } catch { r._codes = []; } } await appendLog(j, "info", `${p.length} price rules`); return p; }
async function iDisc(c, id, data, j) { if (!data) return; let ok = 0; for (const r of data) { try { const res = await c.rest("POST", "/price_rules.json", { price_rule: { title: r.title, target_type: r.target_type, target_selection: r.target_selection, allocation_method: r.allocation_method, value_type: r.value_type, value: r.value, customer_selection: r.customer_selection, starts_at: r.starts_at, ends_at: r.ends_at, usage_limit: r.usage_limit, once_per_customer: r.once_per_customer } }); if (res?.price_rule) { id.set("price_rules", String(r.id), String(res.price_rule.id)); ok++; for (const cd of r._codes || []) { try { await c.rest("POST", `/price_rules/${res.price_rule.id}/discount_codes.json`, { discount_code: { code: cd.code } }); } catch {} } } } catch {} } await appendLog(j, "info", `${ok}/${data.length} price rules`); }

// Shop settings
async function eSettings(c, j) { const data = {}; try { data.locales = (await c.graphql("{ shopLocales { locale primary published } }"))?.shopLocales || []; } catch { data.locales = []; } try { const p = (await c.graphql("{ shop { privacyPolicy{title body} refundPolicy{title body} termsOfService{title body} shippingPolicy{title body} subscriptionPolicy{title body} } }"))?.shop || {}; data.policies = { privacyPolicy: p.privacyPolicy, refundPolicy: p.refundPolicy, termsOfService: p.termsOfService, shippingPolicy: p.shippingPolicy, subscriptionPolicy: p.subscriptionPolicy }; } catch { data.policies = {}; } try { data.scriptTags = await c.restGetAll("/script_tags.json", "script_tags"); } catch { data.scriptTags = []; } await appendLog(j, "info", `${data.locales.length} locales, ${Object.values(data.policies).filter(p => p?.body).length} policies`); return data; }
async function iSettings(c, _, data, j) { if (!data) return; let ok = 0; for (const l of (data.locales || []).filter(l => !l.primary)) { try { await c.graphql(`mutation($l:String!){shopLocaleEnable(locale:$l){shopLocale{locale}userErrors{message}}}`, { l: l.locale }); if (l.published) await c.graphql(`mutation($l:String!){shopLocaleUpdate(locale:$l,shopLocale:{published:true}){shopLocale{locale}userErrors{message}}}`, { l: l.locale }); ok++; } catch {} } for (const [k, t] of [["refundPolicy", "REFUND_POLICY"], ["privacyPolicy", "PRIVACY_POLICY"], ["termsOfService", "TERMS_OF_SERVICE"], ["shippingPolicy", "SHIPPING_POLICY"], ["subscriptionPolicy", "SUBSCRIPTION_POLICY"]]) { const p = data.policies?.[k]; if (!p?.body) continue; try { await c.graphql(`mutation($p:ShopPolicyInput!){shopPolicyUpdate(shopPolicy:$p){shopPolicy{body}userErrors{message}}}`, { p: { type: t, body: p.body } }); ok++; } catch {} } for (const tag of data.scriptTags || []) { try { await c.rest("POST", "/script_tags.json", { script_tag: { event: tag.event, src: tag.src, display_scope: tag.display_scope } }); ok++; } catch {} } await appendLog(j, "info", `${ok} settings`); }

// Translations
const TR_TYPES = ["COLLECTION", "PAGE", "BLOG", "ARTICLE", "LINK", "SHOP", "SHOP_POLICY", "METAOBJECT", "METAFIELD", "MENU", "ONLINE_STORE_THEME", "EMAIL_TEMPLATE", "DELIVERY_METHOD_DEFINITION", "PAYMENT_GATEWAY", "FILTER"];
const TR_MAP = { COLLECTION: { g: "Collection", k: "collections" }, PAGE: { g: "Page", k: "pages" }, BLOG: { g: "Blog", k: "blogs" }, ARTICLE: { g: "Article", k: "articles" }, METAOBJECT: { g: "Metaobject", k: "metaobjects" }, MENU: { g: "Menu", k: "menus" } };
const TR_CM = new Set(["SHOP", "LINK", "ONLINE_STORE_THEME", "EMAIL_TEMPLATE", "DELIVERY_METHOD_DEFINITION", "PAYMENT_GATEWAY", "SHOP_POLICY", "FILTER"]);
async function eTrans(c, j) { const locales = ((await c.graphql("{ shopLocales { locale primary published } }"))?.shopLocales || []).filter(l => !l.primary && l.published); if (!locales.length) { await appendLog(j, "info", "No secondary locales"); return { locales: [], translations: {} }; } const all = {}; let total = 0; for (const rt of TR_TYPES) { all[rt] = []; try { const res = await c.graphqlAll(`query($rt:TranslatableResourceType!,$cursor:String){translatableResources(first:50,after:$cursor,resourceType:$rt){pageInfo{hasNextPage}edges{cursor node{resourceId translatableContent{key value digest locale}}}}}`, { rt }, "translatableResources"); for (const r of res) { const t = { resourceId: r.resourceId, translatableContent: r.translatableContent, translations: {} }; for (const l of locales) { try { const td = await c.graphql(`query($id:ID!,$l:String!){translatableResource(resourceId:$id){translations(locale:$l){key value locale}}}`, { id: r.resourceId, l: l.locale }); const tr = td?.translatableResource?.translations || []; if (tr.length) t.translations[l.locale] = tr; } catch {} } if (Object.keys(t.translations).length) { all[rt].push(t); total++; } } } catch {} } await appendLog(j, "info", `${total} resources with translations`); return { locales, translations: all }; }
async function iTrans(c, id, data, j) { if (!data?.locales?.length) return; for (const l of data.locales) { try { await c.graphql(`mutation($l:String!){shopLocaleEnable(locale:$l){shopLocale{locale}userErrors{message}}}`, { l: l.locale }); if (l.published) await c.graphql(`mutation($l:String!){shopLocaleUpdate(locale:$l,shopLocale:{published:true}){shopLocale{locale}userErrors{message}}}`, { l: l.locale }); } catch {} } let shopId = null; try { shopId = (await c.graphql("{ shop { id } }"))?.shop?.id; } catch {} let ok = 0; for (const [rt, resources] of Object.entries(data.translations || {})) { if (!resources?.length) continue; const m = TR_MAP[rt]; const isCM = TR_CM.has(rt); let tgtRes = null; if (isCM) { try { tgtRes = await c.graphqlAll(`query($rt:TranslatableResourceType!,$cursor:String){translatableResources(first:50,after:$cursor,resourceType:$rt){pageInfo{hasNextPage}edges{cursor node{resourceId translatableContent{key value digest}}}}}`, { rt }, "translatableResources"); } catch { tgtRes = []; } } for (const r of resources) { const sid = extractId(r.resourceId); let tid = null; if (rt === "SHOP") tid = shopId; else if (isCM) { if (m) { const t = id.get(m.k, sid); if (t) tid = buildGid(m.g, t); } if (!tid && tgtRes) { const st = (r.translatableContent || []).find(c => c.key === "title")?.value; for (const tr of tgtRes) { const tt = (tr.translatableContent || []).find(c => c.key === "title")?.value; if (st && tt && st === tt) { tid = tr.resourceId; break; } } } } else if (m) { const t = id.get(m.k, sid); if (t) tid = buildGid(m.g, t); } if (!tid) continue; let digests = {}; try { const dd = await c.graphql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`, { id: tid }); for (const x of dd?.translatableResource?.translatableContent || []) digests[x.key] = x.digest; } catch { continue; } for (const [locale, trans] of Object.entries(r.translations)) { const inputs = trans.filter(t => t.value && digests[t.key]).map(t => ({ key: t.key, value: t.value, locale, translatableContentDigest: digests[t.key] })); if (!inputs.length) continue; try { await c.graphql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){translations{key}userErrors{message}}}`, { id: tid, t: inputs }); ok++; } catch {} } } } await appendLog(j, "info", `${ok} translation resources`); }

const EXP = { theme: eTheme, collections: eColl, pages: ePages, blogs: eBlogs, menus: eMenus, metafields: eMf, metaobjects: eMo, customers: eCust, files: eFiles, redirects: eRedir, discounts: eDisc, "shop-settings": eSettings, translations: eTrans };
const IMP = { theme: iTheme, collections: iColl, pages: iPages, blogs: iBlogs, menus: iMenus, metafields: iMf, metaobjects: iMo, customers: iCust, files: iFiles, redirects: iRedir, discounts: iDisc, "shop-settings": iSettings, translations: iTrans };
