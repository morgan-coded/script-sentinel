-- CreateTable
CREATE TABLE "Shop" (
    "myshopifyDomain" TEXT NOT NULL PRIMARY KEY,
    "shopName" TEXT,
    "isPlus" BOOLEAN NOT NULL DEFAULT false,
    "isDevelopment" BOOLEAN NOT NULL DEFAULT false,
    "planDisplayName" TEXT,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME
);

-- CreateTable
CREATE TABLE "Charge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "shopifyChargeGid" TEXT,
    "confirmationUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "activatedAt" DATETIME,
    "cancelledAt" DATETIME,
    CONSTRAINT "Charge_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Charge_shopifyChargeGid_key" ON "Charge"("shopifyChargeGid");

-- CreateIndex
CREATE INDEX "Charge_shopDomain_status_idx" ON "Charge"("shopDomain", "status");

-- CreateIndex
CREATE INDEX "Charge_planKey_idx" ON "Charge"("planKey");
