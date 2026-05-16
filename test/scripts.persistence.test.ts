import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import db from "../app/db.server";
import {
  archiveScript,
  createPastedScript,
  deleteScript,
  getScript,
  listScripts,
  setOverrideCategory,
  unarchiveScript,
} from "../app/lib/shopify/scripts";

/**
 * Persistence test for the Script Sentinel scripts module.
 *
 * Exercises the real Prisma schema and verifies the round trip from intake →
 * classify → list → override → archive.
 *
 * Isolation: each persistence test uses a unique shop domain and cleans up in
 * `afterAll`. Vitest is configured with `pool: "forks"` so the test file owns
 * its own process.
 */

const SHOP = `persistence-test-${Date.now()}.myshopify.com`;

beforeAll(async () => {
  await db.shop.upsert({
    where: { myshopifyDomain: SHOP },
    update: {},
    create: {
      myshopifyDomain: SHOP,
      isPlus: true,
      isDevelopment: true,
    },
  });
});

beforeEach(async () => {
  // Clear scripts created by prior tests in this file. ScriptClassification
  // cascades automatically via the schema relation.
  await db.discoveredScript.deleteMany({ where: { shopDomain: SHOP } });
});

afterAll(async () => {
  await db.discoveredScript.deleteMany({ where: { shopDomain: SHOP } });
  await db.shop.deleteMany({ where: { myshopifyDomain: SHOP } });
  await db.$disconnect();
});

describe("createPastedScript + listScripts roundtrip", () => {
  it("persists the paste, runs the classifier, and lists with the correct category", async () => {
    const id = await createPastedScript({
      shopDomain: SHOP,
      title: "10% off everything",
      source: `
        cart.line_items.each do |line_item|
          line_item.change_line_price(line_item.line_price * 0.9, message: "10% off")
        end
      `,
      scriptType: "line_item",
      isActive: true,
    });
    expect(typeof id).toBe("string");

    const list = await listScripts(SHOP);
    expect(list).toHaveLength(1);
    const [first] = list;
    expect(first.title).toBe("10% off everything");
    expect(first.scriptType).toBe("line_item");
    expect(first.isActive).toBe(true);
    expect(first.classification.autoCategory).toBe("discount");
    expect(first.classification.autoConfidence).toBeGreaterThan(0.6);
    // autoSignals is stored as a JSON string; the hydrate step parses it back
    // into an array.
    expect(Array.isArray(first.classification.autoSignals)).toBe(true);
    expect(first.classification.autoSignals.length).toBeGreaterThan(0);
    // No override yet.
    expect(first.classification.overrideCategory).toBeNull();
  });

  it("scopes the listing to the shop — never leaks cross-shop", async () => {
    const otherShop = `${SHOP}.alt`;
    await db.shop.create({
      data: {
        myshopifyDomain: otherShop,
        isPlus: true,
      },
    });
    try {
      await createPastedScript({
        shopDomain: SHOP,
        title: "ours",
        source: "cart.line_items.each { |li| li.change_line_price(li.line_price * 0.9) }",
        scriptType: "line_item",
      });
      await createPastedScript({
        shopDomain: otherShop,
        title: "theirs",
        source: "cart.line_items.each { |li| li.change_line_price(li.line_price * 0.5) }",
        scriptType: "line_item",
      });
      const ours = await listScripts(SHOP);
      expect(ours).toHaveLength(1);
      expect(ours[0].title).toBe("ours");
    } finally {
      await db.discoveredScript.deleteMany({ where: { shopDomain: otherShop } });
      await db.shop.delete({ where: { myshopifyDomain: otherShop } });
    }
  });
});

describe("setOverrideCategory", () => {
  async function seedDiscount(): Promise<string> {
    return createPastedScript({
      shopDomain: SHOP,
      title: "BOGO",
      source: `
        cart.line_items.each do |li|
          li.change_line_price(li.line_price - li.variant.price, message: "BOGO")
        end
      `,
      scriptType: "line_item",
    });
  }

  it("flips the effective category to the override when set", async () => {
    const id = await seedDiscount();
    await setOverrideCategory(id, "b2b", "Actually wholesale-only logic");
    const after = await getScript(SHOP, id);
    expect(after?.classification.autoCategory).toBe("discount");
    expect(after?.classification.overrideCategory).toBe("b2b");
    expect(after?.classification.overrideReason).toBe("Actually wholesale-only logic");
    expect(after?.classification.overrideUpdatedAt).toBeInstanceOf(Date);
  });

  it("clearing the override (passing null) falls back to the auto category and wipes the reason", async () => {
    const id = await seedDiscount();
    await setOverrideCategory(id, "b2b", "wrong");
    await setOverrideCategory(id, null, null);
    const after = await getScript(SHOP, id);
    expect(after?.classification.overrideCategory).toBeNull();
    expect(after?.classification.overrideReason).toBeNull();
    expect(after?.classification.overrideUpdatedAt).toBeNull();
    expect(after?.classification.autoCategory).toBe("discount");
  });
});

describe("archive / unarchive / delete", () => {
  it("archive flips isActive and stamps archivedAt; unarchive reverts", async () => {
    const id = await createPastedScript({
      shopDomain: SHOP,
      title: "x",
      source: "Output.shipping_rates = Input.shipping_rates",
      scriptType: "shipping",
    });
    await archiveScript(id);
    const archived = await getScript(SHOP, id);
    expect(archived?.isActive).toBe(false);
    expect(archived?.archivedAt).toBeInstanceOf(Date);
    await unarchiveScript(id);
    const restored = await getScript(SHOP, id);
    expect(restored?.isActive).toBe(true);
    expect(restored?.archivedAt).toBeNull();
  });

  it("delete cascades the classification row", async () => {
    const id = await createPastedScript({
      shopDomain: SHOP,
      title: "y",
      source: "Output.shipping_rates = Input.shipping_rates",
      scriptType: "shipping",
    });
    await deleteScript(id);
    const remaining = await db.discoveredScript.findUnique({ where: { id } });
    expect(remaining).toBeNull();
    const orphan = await db.scriptClassification.findUnique({
      where: { scriptId: id },
    });
    expect(orphan).toBeNull();
  });
});
