-- CreateTable
CREATE TABLE "AuditPurchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "shopifyChargeGid" TEXT,
    "confirmationUrl" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" DATETIME,
    "expiresAt" DATETIME,
    CONSTRAINT "AuditPurchase_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'single',
    "snapshot" TEXT NOT NULL,
    "scriptCount" INTEGER NOT NULL DEFAULT 0,
    "fixtureCount" INTEGER NOT NULL DEFAULT 0,
    "highRiskCount" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filename" TEXT NOT NULL,
    CONSTRAINT "AuditReport_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditReport_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "AuditPurchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditPurchase_shopifyChargeGid_key" ON "AuditPurchase"("shopifyChargeGid");

-- CreateIndex
CREATE INDEX "AuditPurchase_shopDomain_status_idx" ON "AuditPurchase"("shopDomain", "status");

-- CreateIndex
CREATE INDEX "AuditReport_shopDomain_generatedAt_idx" ON "AuditReport"("shopDomain", "generatedAt");
