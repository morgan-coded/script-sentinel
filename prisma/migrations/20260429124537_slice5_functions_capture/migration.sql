-- CreateTable
CREATE TABLE "DiscoveredFunction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "apiType" TEXT NOT NULL,
    "apiVersion" TEXT,
    "appTitle" TEXT,
    "acknowledgedAt" DATETIME,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiscoveredFunction_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CaptureRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "windowFromAt" DATETIME NOT NULL,
    "windowToAt" DATETIME NOT NULL,
    "ordersExamined" INTEGER NOT NULL DEFAULT 0,
    "outputsCaptured" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    CONSTRAINT "CaptureRun_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FunctionOutput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "captureRunId" TEXT NOT NULL,
    "functionId" TEXT,
    "sourceOrderGid" TEXT NOT NULL,
    "fixtureSignature" TEXT NOT NULL,
    "observedDiscountAmount" REAL NOT NULL DEFAULT 0,
    "observedShippingCode" TEXT,
    "observedShippingTitle" TEXT,
    "observedShippingAmount" REAL,
    "observedPaymentGateways" TEXT NOT NULL DEFAULT '[]',
    "observedDiscountCodes" TEXT NOT NULL DEFAULT '[]',
    "cartTotal" REAL NOT NULL DEFAULT 0,
    "presentmentCurrency" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FunctionOutput_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunctionOutput_captureRunId_fkey" FOREIGN KEY ("captureRunId") REFERENCES "CaptureRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FunctionOutput_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "DiscoveredFunction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DiscoveredFunction_shopDomain_apiType_idx" ON "DiscoveredFunction"("shopDomain", "apiType");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredFunction_shopDomain_externalId_key" ON "DiscoveredFunction"("shopDomain", "externalId");

-- CreateIndex
CREATE INDEX "CaptureRun_shopDomain_startedAt_idx" ON "CaptureRun"("shopDomain", "startedAt");

-- CreateIndex
CREATE INDEX "FunctionOutput_shopDomain_capturedAt_idx" ON "FunctionOutput"("shopDomain", "capturedAt");

-- CreateIndex
CREATE INDEX "FunctionOutput_shopDomain_functionId_idx" ON "FunctionOutput"("shopDomain", "functionId");

-- CreateIndex
CREATE UNIQUE INDEX "FunctionOutput_shopDomain_fixtureSignature_sourceOrderGid_key" ON "FunctionOutput"("shopDomain", "fixtureSignature", "sourceOrderGid");
