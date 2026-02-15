import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "@remix-run/react";
import { useState, useEffect, useCallback } from "react";
import {
  Page, Layout, Card, FormLayout, TextField, Button, Banner,
  ProgressBar, BlockStack, InlineStack, Text, Badge, Divider,
  Box, Scrollable, Checkbox, InlineGrid,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server.js";
import { ALL_MODULES, resolveSourceToken, startMigration } from "../services/migration.server.js";
import prisma from "../db.server.js";

// ─── Loader ───────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const latestJob = await prisma.migrationJob.findFirst({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  return json({
    shop: session.shop,
    modules: ALL_MODULES,
    job: latestJob ? {
      id: latestJob.id, status: latestJob.status, progress: latestJob.progress,
      currentModule: latestJob.currentModule, totalModules: latestJob.totalModules,
      doneModules: latestJob.doneModules, sourceShop: latestJob.sourceShop,
      logs: JSON.parse(latestJob.logs || "[]").slice(-80),
      errorMessage: latestJob.errorMessage, completedAt: latestJob.completedAt,
    } : null,
  });
};

// ─── Action ───────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "start") {
    const sourceShop = form.get("sourceShop")?.toString().trim();
    const sourceToken = form.get("sourceToken")?.toString().trim();
    const sourceClientId = form.get("sourceClientId")?.toString().trim();
    const sourceClientSecret = form.get("sourceClientSecret")?.toString().trim();
    const modules = form.get("modules")?.toString() || "all";

    if (!sourceShop) return json({ error: "Source store domain is required" }, { status: 400 });

    let resolvedToken;
    try {
      resolvedToken = await resolveSourceToken(sourceShop, sourceToken, sourceClientId, sourceClientSecret);
    } catch (err) {
      return json({ error: `Source auth failed: ${err.message}` }, { status: 400 });
    }

    const job = await prisma.migrationJob.create({
      data: { shop: session.shop, sourceShop, sourceToken: resolvedToken, modules, status: "pending" },
    });

    // Start migration in background — target token is session.accessToken
    startMigration(job.id, session.accessToken).catch(async (err) => {
      await prisma.migrationJob.update({
        where: { id: job.id },
        data: { status: "failed", errorMessage: err.message },
      });
    });

    return json({ success: true, jobId: job.id });
  }

  if (intent === "cancel") {
    const jobId = form.get("jobId")?.toString();
    if (jobId) await prisma.migrationJob.update({ where: { id: jobId }, data: { status: "cancelled" } });
    return json({ success: true });
  }

  if (intent === "poll") {
    const jobId = form.get("jobId")?.toString();
    if (!jobId) return json({ job: null });
    const job = await prisma.migrationJob.findUnique({ where: { id: jobId } });
    if (!job) return json({ job: null });
    return json({
      job: {
        id: job.id, status: job.status, progress: job.progress,
        currentModule: job.currentModule, totalModules: job.totalModules,
        doneModules: job.doneModules,
        logs: JSON.parse(job.logs || "[]").slice(-80),
        errorMessage: job.errorMessage,
      },
    });
  }

  return json({});
};

// ─── Component ────────────────────────────────────────────

export default function Index() {
  const { shop, modules, job: initialJob } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const nav = useNavigation();

  const [sourceShop, setSourceShop] = useState("");
  const [sourceToken, setSourceToken] = useState("");
  const [sourceClientId, setSourceClientId] = useState("");
  const [sourceClientSecret, setSourceClientSecret] = useState("");
  const [authMode, setAuthMode] = useState("creds"); // "creds" or "token"
  const [selectedModules, setSelectedModules] = useState(modules.map(m => m.name));
  const [activeJob, setActiveJob] = useState(initialJob);
  const [logs, setLogs] = useState(initialJob?.logs || []);

  const isRunning = activeJob?.status === "running" || activeJob?.status === "pending";

  // Poll
  useEffect(() => {
    if (!isRunning || !activeJob?.id) return;
    const interval = setInterval(() => {
      const fd = new FormData();
      fd.set("intent", "poll"); fd.set("jobId", activeJob.id);
      submit(fd, { method: "post" });
    }, 2000);
    return () => clearInterval(interval);
  }, [isRunning, activeJob?.id, submit]);

  useEffect(() => {
    if (actionData?.job) { setActiveJob(actionData.job); setLogs(actionData.job.logs || []); }
    if (actionData?.jobId && !activeJob?.id) setActiveJob({ id: actionData.jobId, status: "pending", progress: 0 });
  }, [actionData]);

  const handleStart = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "start");
    fd.set("sourceShop", sourceShop);
    fd.set("modules", selectedModules.join(","));
    if (authMode === "token") fd.set("sourceToken", sourceToken);
    else { fd.set("sourceClientId", sourceClientId); fd.set("sourceClientSecret", sourceClientSecret); }
    submit(fd, { method: "post" });
  }, [sourceShop, sourceToken, sourceClientId, sourceClientSecret, authMode, selectedModules, submit]);

  const handleCancel = useCallback(() => {
    if (!activeJob?.id) return;
    const fd = new FormData(); fd.set("intent", "cancel"); fd.set("jobId", activeJob.id);
    submit(fd, { method: "post" });
  }, [activeJob, submit]);

  const newMigration = useCallback(() => { setActiveJob(null); setLogs([]); }, []);
  const toggleModule = useCallback((name) => {
    setSelectedModules(p => p.includes(name) ? p.filter(n => n !== name) : [...p, name]);
  }, []);

  const badge = (status) => {
    const map = { pending: ["attention", "Pending"], running: ["info", "Running"], completed: ["success", "Completed"], failed: ["critical", "Failed"], cancelled: ["warning", "Cancelled"] };
    const [tone, label] = map[status] || ["", status];
    return <Badge tone={tone}>{label}</Badge>;
  };

  const hasSourceAuth = authMode === "token" ? sourceToken : (sourceClientId && sourceClientSecret);

  return (
    <Page title="Store Cloner">
      <Layout>
        {actionData?.error && (
          <Layout.Section><Banner tone="critical"><p>{actionData.error}</p></Banner></Layout.Section>
        )}

        {/* Active job */}
        {activeJob && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text variant="headingMd" as="h2">Migration {badge(activeJob.status)}</Text>
                  {!isRunning && <Button onClick={newMigration} variant="plain">New migration</Button>}
                </InlineStack>

                {activeJob.sourceShop && (
                  <Text tone="subdued">{activeJob.sourceShop} → {shop}</Text>
                )}

                {isRunning && (
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text variant="bodySm">{activeJob.currentModule ? `Processing: ${activeJob.currentModule}` : "Starting..."}</Text>
                      <Text variant="bodySm">{activeJob.doneModules || 0}/{activeJob.totalModules || "?"}</Text>
                    </InlineStack>
                    <ProgressBar progress={activeJob.progress || 0} tone="primary" size="small" />
                    <InlineStack align="end"><Button onClick={handleCancel} tone="critical" variant="plain">Cancel</Button></InlineStack>
                  </BlockStack>
                )}

                {activeJob.status === "completed" && <Banner tone="success" title="Migration complete!" />}
                {activeJob.status === "failed" && <Banner tone="critical" title="Failed">{activeJob.errorMessage}</Banner>}

                {logs.length > 0 && (
                  <BlockStack gap="200">
                    <Divider />
                    <Text variant="headingSm">Logs</Text>
                    <Box background="bg-surface-secondary" padding="300" borderRadius="200" minHeight="200px" maxHeight="400px" overflowY="scroll">
                      <Scrollable>
                        <BlockStack gap="100">
                          {logs.map((log, i) => (
                            <Text key={i} variant="bodySm" fontFamily="mono" tone={log.level === "error" ? "critical" : log.level === "success" ? "success" : log.level === "warn" ? "caution" : "subdued"}>
                              <Text variant="bodySm" tone="subdued" as="span">{new Date(log.time).toLocaleTimeString()}</Text> {log.message}
                            </Text>
                          ))}
                        </BlockStack>
                      </Scrollable>
                    </Box>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Setup form */}
        {!activeJob && (
          <>
            <Layout.Section>
              <Banner tone="info">
                <p>This app is installed on <strong>{shop}</strong> (target store). Just enter the SOURCE store credentials below and click Clone.</p>
              </Banner>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Source Store (copy FROM)</Text>
                  <FormLayout>
                    <TextField label="Store domain" value={sourceShop} onChange={setSourceShop} placeholder="source-store.myshopify.com" autoComplete="off" />

                    <InlineStack gap="200">
                      <Button pressed={authMode === "creds"} onClick={() => setAuthMode("creds")} size="slim">Client ID + Secret</Button>
                      <Button pressed={authMode === "token"} onClick={() => setAuthMode("token")} size="slim">Access Token</Button>
                    </InlineStack>

                    {authMode === "creds" ? (
                      <>
                        <TextField label="Client ID" value={sourceClientId} onChange={setSourceClientId} autoComplete="off" />
                        <TextField label="Client Secret" value={sourceClientSecret} onChange={setSourceClientSecret} type="password" autoComplete="off" />
                      </>
                    ) : (
                      <TextField label="Admin API access token" value={sourceToken} onChange={setSourceToken} type="password" autoComplete="off" helpText="Settings → Apps → Develop apps" />
                    )}
                  </FormLayout>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text variant="headingMd" as="h2">What to clone</Text>
                    <InlineStack gap="200">
                      <Button onClick={() => setSelectedModules(modules.map(m => m.name))} variant="plain" size="slim">All</Button>
                      <Button onClick={() => setSelectedModules([])} variant="plain" size="slim">None</Button>
                    </InlineStack>
                  </InlineStack>
                  <InlineGrid columns={2} gap="200">
                    {modules.map(m => (
                      <Checkbox key={m.name} label={m.label} checked={selectedModules.includes(m.name)} onChange={() => toggleModule(m.name)} />
                    ))}
                  </InlineGrid>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section>
              <InlineStack align="end">
                <Button variant="primary" size="large" onClick={handleStart} loading={nav.state === "submitting"} disabled={!sourceShop || !hasSourceAuth || selectedModules.length === 0}>
                  Clone to {shop}
                </Button>
              </InlineStack>
            </Layout.Section>
          </>
        )}

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">How it works</Text>
              <Text variant="bodyMd"><strong>1.</strong> Create a custom app on the SOURCE store</Text>
              <Text variant="bodyMd"><strong>2.</strong> Enter its credentials above</Text>
              <Text variant="bodyMd"><strong>3.</strong> Click "Clone" — data copies directly into this store</Text>
              <Divider />
              <Text variant="bodySm" tone="subdued">Theme, collections, pages, blogs, menus, metafields, metaobjects, customers, media, redirects, discounts, settings, translations.</Text>
              <Divider />
              <Text variant="bodySm" tone="subdued">
                Developed with 💛 by <a href="https://t.me/denys_maksymuck" target="_blank" rel="noopener">Denys</a>
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
