import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, Link, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { fetchShopPlan } from "../lib/shopify/plan.server";
import { upsertShopFromPlan } from "../lib/shopify/shop.server";
import {
  asScriptType,
  createPastedScript,
  listScripts,
} from "../lib/shopify/scripts";
import {
  CATEGORY_LABEL,
  type ClassificationCategory,
} from "../lib/classifier/script-classifier";
import { NON_PLUS_GATE_MESSAGE } from "../lib/shopify/plan-copy";

/**
 * Script discovery and classification.
 *
 * Intake: merchant-paste only. Verified that Shopify's Admin API in
 * 2026-04 does not expose legacy Script Editor scripts. The merchant copies
 * each Ruby script from their admin UI ("Apps and sales channels → Script
 * Editor → script → View source") and pastes it into the form below.
 */

const SCRIPT_TYPE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "Line item (discount / promotion)", value: "line_item" },
  { label: "Shipping rule", value: "shipping" },
  { label: "Payment customization", value: "payment" },
  { label: "Unknown / not sure", value: "unknown" },
];

// Loader-shape view of a script — Dates serialised to ISO strings so the
// JSON-over-HTTP transport doesn't drop them. The list item component below
// consumes this shape, not the persistence-layer record.
type ScriptListItem = {
  id: string;
  title: string;
  scriptType: string;
  isActive: boolean;
  updatedAt: string;
  shopifyUpdatedAt: string | null;
  classification: {
    autoCategory: string;
    autoConfidence: number;
    overrideCategory: string | null;
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  await upsertShopFromPlan(session.shop, plan);

  if (!plan.isPlus) {
    return {
      isPlus: false as const,
      planDisplayName: plan.publicDisplayName,
      scripts: [] as ScriptListItem[],
      shopDomain: session.shop,
    };
  }

  const scripts: ScriptListItem[] = (await listScripts(session.shop)).map((s) => ({
    id: s.id,
    title: s.title,
    scriptType: s.scriptType,
    isActive: s.isActive,
    updatedAt: s.updatedAt.toISOString(),
    shopifyUpdatedAt: s.shopifyUpdatedAt?.toISOString() ?? null,
    classification: {
      autoCategory: s.classification.autoCategory,
      autoConfidence: s.classification.autoConfidence,
      overrideCategory: s.classification.overrideCategory,
    },
  }));
  return {
    isPlus: true as const,
    planDisplayName: plan.publicDisplayName,
    scripts,
    shopDomain: session.shop,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // Re-check Plus on every mutation. Cheap and avoids a non-Plus shop ever
  // landing data on disk via a forged form post.
  const plan = await fetchShopPlan(admin);
  if (!plan.isPlus) {
    throw new Response("Plus required", { status: 403 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "paste") {
    const title = String(formData.get("title") ?? "").trim();
    const source = String(formData.get("source") ?? "");
    const scriptType = asScriptType(String(formData.get("scriptType") ?? ""));
    if (source.trim().length === 0) {
      return { error: "Paste the Ruby source before submitting." };
    }
    if (source.length > 100_000) {
      // Defensive cap — Shopify Scripts have a 64 KB source limit; anything
      // an order of magnitude larger is almost certainly an upload mistake.
      return { error: "Source exceeds 100,000 characters. Paste a single script at a time." };
    }
    await createPastedScript({
      shopDomain: session.shop,
      title,
      source,
      scriptType,
      isActive: true,
    });
    return { ok: true as const };
  }

  return { error: "Unknown intent." };
};

export default function ScriptsIndex() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [selectedTab, setSelectedTab] = useState(0);

  if (!data.isPlus) {
    return (
      <Page>
        <TitleBar title="Scripts" />
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingLg">
              Shopify Plus required
            </Text>
            <Text as="p" variant="bodyMd">
              {NON_PLUS_GATE_MESSAGE}
            </Text>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  const active = data.scripts.filter((s) => s.isActive);
  const archived = data.scripts.filter((s) => !s.isActive);
  const tabs = [
    {
      id: "active",
      content: `Active (${active.length})`,
      panelID: "scripts-active",
    },
    {
      id: "archived",
      content: `Inactive / archived (${archived.length})`,
      panelID: "scripts-archived",
    },
  ];
  const currentList = selectedTab === 0 ? active : archived;

  return (
    <Page>
      <TitleBar title="Scripts" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Add a script
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Shopify's 2026-04 Admin API does not expose Script Editor
                  scripts, so paste the Ruby source from your admin UI. Each
                  paste is classified automatically; you can override the
                  category from the script's detail page.
                </Text>
                <PasteForm submitting={isSubmitting} />
              </BlockStack>
            </Card>

            <Box paddingBlockStart="500">
              <Card padding="0">
                <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
                  <Box padding="400">
                    {currentList.length === 0 ? (
                      <EmptyState
                        heading={
                          selectedTab === 0
                            ? "No active scripts yet"
                            : "Nothing archived"
                        }
                        image=""
                      >
                        <p>
                          {selectedTab === 0
                            ? "Paste your first Shopify Script above to start the inventory."
                            : "Scripts you archive will appear here."}
                        </p>
                      </EmptyState>
                    ) : (
                      <BlockStack gap="200">
                        {currentList.map((script) => (
                          <ScriptListItem key={script.id} script={script} />
                        ))}
                      </BlockStack>
                    )}
                  </Box>
                </Tabs>
              </Card>
            </Box>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function PasteForm({ submitting }: { submitting: boolean }) {
  const [title, setTitle] = useState("");
  const [scriptType, setScriptType] = useState("line_item");
  const [source, setSource] = useState("");
  return (
    <Form method="post" replace>
      <input type="hidden" name="intent" value="paste" />
      <FormLayout>
        <TextField
          label="Title"
          name="title"
          value={title}
          onChange={setTitle}
          autoComplete="off"
          helpText="Shown in your inventory; copy the title used in Script Editor."
        />
        <Select
          label="Script type"
          name="scriptType"
          options={SCRIPT_TYPE_OPTIONS}
          value={scriptType}
          onChange={setScriptType}
        />
        <TextField
          label="Ruby source"
          name="source"
          value={source}
          onChange={setSource}
          multiline={8}
          autoComplete="off"
          monospaced
          helpText="Pasted verbatim. Stored as text only — never executed by Script Sentinel."
        />
        <InlineStack align="end">
          <Button submit variant="primary" loading={submitting}>
            Add script
          </Button>
        </InlineStack>
      </FormLayout>
    </Form>
  );
}

function ScriptListItem({ script }: { script: ScriptListItem }) {
  const overrideCategory = script.classification.overrideCategory as
    | ClassificationCategory
    | null;
  const autoCategory = script.classification.autoCategory as ClassificationCategory;
  const effective: ClassificationCategory = overrideCategory ?? autoCategory;
  const isLowConfidence =
    overrideCategory === null && script.classification.autoConfidence < 0.6;
  return (
    <Box
      padding="300"
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
    >
      <InlineStack align="space-between" blockAlign="center" gap="200">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Link to={`/app/scripts/${script.id}`}>
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {script.title}
              </Text>
            </Link>
            <Badge tone={badgeToneFor(effective)}>{CATEGORY_LABEL[effective]}</Badge>
            {overrideCategory ? <Badge tone="info">Manually set</Badge> : null}
            {isLowConfidence ? <Badge tone="warning">Needs review</Badge> : null}
          </InlineStack>
          <Text as="span" variant="bodySm" tone="subdued">
            Type: {scriptTypeLabel(script.scriptType)} · Updated{" "}
            {script.updatedAt.slice(0, 10)}
            {script.shopifyUpdatedAt
              ? ` · Shopify modified ${script.shopifyUpdatedAt.slice(0, 10)}`
              : ""}
          </Text>
        </BlockStack>
        <Link to={`/app/scripts/${script.id}`}>
          <Text as="span" variant="bodySm">
            View source →
          </Text>
        </Link>
      </InlineStack>
    </Box>
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
