import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, Link, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { fetchShopPlan } from "../lib/shopify/plan.server";
import { upsertShopFromPlan } from "../lib/shopify/shop.server";
import {
  archiveScript,
  deleteScript,
  getScript,
  setOverrideCategory,
  unarchiveScript,
} from "../lib/shopify/scripts";
import {
  asCategory,
  CATEGORY_LABEL,
  CLASSIFICATION_CATEGORIES,
  type ClassificationCategory,
} from "../lib/classifier/script-classifier";

const CATEGORY_OPTIONS = [
  { label: "Use auto-classified category", value: "" },
  ...CLASSIFICATION_CATEGORIES.map((c) => ({
    label: CATEGORY_LABEL[c],
    value: c,
  })),
];

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  await upsertShopFromPlan(session.shop, plan);
  if (!plan.isPlus) {
    throw new Response("Plus required", { status: 403 });
  }
  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });
  const script = await getScript(session.shop, id);
  if (!script) throw new Response("Not found", { status: 404 });

  return {
    script: {
      ...script,
      // Serialize the dates so Remix can transport them.
      createdAt: script.createdAt.toISOString(),
      updatedAt: script.updatedAt.toISOString(),
      archivedAt: script.archivedAt?.toISOString() ?? null,
      shopifyUpdatedAt: script.shopifyUpdatedAt?.toISOString() ?? null,
      classification: {
        ...script.classification,
        overrideUpdatedAt:
          script.classification.overrideUpdatedAt?.toISOString() ?? null,
      },
    },
  };
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  if (!plan.isPlus) {
    throw new Response("Plus required", { status: 403 });
  }
  const id = params.id;
  if (!id) throw new Response("Not found", { status: 404 });
  const existing = await getScript(session.shop, id);
  if (!existing) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "override") {
    const raw = String(formData.get("override") ?? "");
    const reason = String(formData.get("reason") ?? "").trim() || null;
    // Empty string clears the override (back to auto-classified).
    const next = raw === "" ? null : asCategory(raw);
    await setOverrideCategory(id, next, reason);
    return { ok: true as const };
  }
  if (intent === "archive") {
    await archiveScript(id);
    return { ok: true as const };
  }
  if (intent === "unarchive") {
    await unarchiveScript(id);
    return { ok: true as const };
  }
  if (intent === "delete") {
    await deleteScript(id);
    // After delete, redirect back to the list — but Remix expects a Response.
    return new Response(null, { status: 303, headers: { Location: "/app/scripts" } });
  }
  return { error: "Unknown intent." };
};

export default function ScriptDetail() {
  const { script } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const effective: ClassificationCategory =
    (script.classification.overrideCategory as ClassificationCategory | null) ??
    (script.classification.autoCategory as ClassificationCategory);

  const [overrideValue, setOverrideValue] = useState<string>(
    script.classification.overrideCategory ?? "",
  );
  const [reason, setReason] = useState<string>(
    script.classification.overrideReason ?? "",
  );

  return (
    <Page
      backAction={{ content: "Scripts", url: "/app/scripts" }}
      title={script.title}
      titleMetadata={
        <InlineStack gap="200">
          <Badge tone={badgeToneFor(effective)}>{CATEGORY_LABEL[effective]}</Badge>
          {script.classification.overrideCategory ? (
            <Badge tone="info">Manually set</Badge>
          ) : null}
          {!script.isActive ? <Badge tone="warning">Archived</Badge> : null}
        </InlineStack>
      }
    >
      <TitleBar title={script.title} />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Ruby source
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Rendered as plain text. Script Sentinel never evaluates merchant
                Ruby; this view is for inspection only.
              </Text>
              {/*
                Critical security boundary: render source inside a <pre>{"..."}</pre>
                pair with React's text-content interpolation. React escapes the
                child string automatically, so any HTML or script tags in the
                Ruby source are rendered as literal text. Do NOT switch this to
                dangerouslySetInnerHTML or any markdown/HTML processor.
              */}
              <Box
                padding="300"
                background="bg-surface-secondary"
                borderColor="border"
                borderWidth="025"
                borderRadius="200"
                overflowX="scroll"
              >
                <pre
                  style={{
                    margin: 0,
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontSize: 13,
                    lineHeight: 1.45,
                    whiteSpace: "pre",
                  }}
                >
                  {script.source}
                </pre>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Classification
                </Text>
                <Text as="p" variant="bodySm">
                  Auto-detected:{" "}
                  <Badge tone={badgeToneFor(script.classification.autoCategory as ClassificationCategory)}>
                    {CATEGORY_LABEL[script.classification.autoCategory as ClassificationCategory]}
                  </Badge>
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Confidence{" "}
                  {(script.classification.autoConfidence * 100).toFixed(0)}%
                </Text>
                {script.classification.autoSignals.length > 0 ? (
                  <List type="bullet">
                    {script.classification.autoSignals.map((signal) => (
                      <List.Item key={signal}>{signal}</List.Item>
                    ))}
                  </List>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No strong signals matched. Use the override below.
                  </Text>
                )}

                <Box paddingBlockStart="300">
                  <Form method="post">
                    <input type="hidden" name="intent" value="override" />
                    <BlockStack gap="200">
                      <Select
                        label="Override category"
                        name="override"
                        options={CATEGORY_OPTIONS}
                        value={overrideValue}
                        onChange={setOverrideValue}
                      />
                      <TextField
                        label="Reason (optional)"
                        name="reason"
                        value={reason}
                        onChange={setReason}
                        autoComplete="off"
                        multiline={2}
                      />
                      <InlineStack align="end">
                        <Button submit loading={submitting}>
                          Save override
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Form>
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Status
                </Text>
                <Text as="p" variant="bodySm">
                  Type: {scriptTypeLabel(script.scriptType)}
                </Text>
                <Text as="p" variant="bodySm">
                  Origin: {script.origin === "paste" ? "Pasted" : "Admin API"}
                </Text>
                <Text as="p" variant="bodySm">
                  Added {script.createdAt.slice(0, 10)}
                </Text>
                <InlineStack gap="200">
                  {script.isActive ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="archive" />
                      <Button submit tone="critical" variant="tertiary" loading={submitting}>
                        Archive
                      </Button>
                    </Form>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="unarchive" />
                      <Button submit loading={submitting}>
                        Restore
                      </Button>
                    </Form>
                  )}
                  <Form
                    method="post"
                    onSubmit={(e) => {
                      if (
                        !window.confirm(
                          "Delete this script? The override and history will be lost.",
                        )
                      ) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="intent" value="delete" />
                    <Button submit tone="critical" loading={submitting}>
                      Delete
                    </Button>
                  </Form>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Audit-trail next steps
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Slice 3 generates cart fixtures from your standard 60-day
                  order window. Slice 4 turns this script's classification + the
                  fixtures into a Migration Risk PDF.
                </Text>
                <Link to="/app">Back to dashboard</Link>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function scriptTypeLabel(t: string): string {
  switch (t) {
    case "line_item":
      return "Line item";
    case "shipping":
      return "Shipping";
    case "payment":
      return "Payment";
    default:
      return "Unknown";
  }
}

function badgeToneFor(
  category: ClassificationCategory,
): "success" | "info" | "warning" | "attention" | "critical" | undefined {
  switch (category) {
    case "discount":
      return "success";
    case "shipping":
      return "info";
    case "payment":
      return "attention";
    case "market_pricing":
      return "info";
    case "b2b":
      return "info";
    case "other":
      return "warning";
  }
}
