-- CreateTable
CREATE TABLE "CartFixture" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "lineItems" TEXT NOT NULL,
    "customerTagSignature" TEXT NOT NULL DEFAULT '',
    "shippingCountryCode" TEXT,
    "shippingPostalPrefix" TEXT,
    "presentmentCurrency" TEXT NOT NULL,
    "marketSignature" TEXT NOT NULL DEFAULT '',
    "discountSignature" TEXT NOT NULL DEFAULT '',
    "quantitySamples" TEXT NOT NULL DEFAULT '[]',
    "observationCount" INTEGER NOT NULL DEFAULT 1,
    "firstObservedAt" DATETIME NOT NULL,
    "lastObservedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CartFixture_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FixtureBaseline" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fixtureId" TEXT NOT NULL,
    "totalDiscountAmount" REAL NOT NULL DEFAULT 0,
    "discountApplications" TEXT NOT NULL DEFAULT '[]',
    "shippingRateCode" TEXT,
    "shippingRateTitle" TEXT,
    "shippingRateAmount" REAL,
    "paymentGatewayNames" TEXT NOT NULL DEFAULT '[]',
    "cartTotal" REAL NOT NULL DEFAULT 0,
    "capturedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FixtureBaseline_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "CartFixture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CartFixture_shopDomain_lastObservedAt_idx" ON "CartFixture"("shopDomain", "lastObservedAt");

-- CreateIndex
CREATE INDEX "CartFixture_shopDomain_presentmentCurrency_idx" ON "CartFixture"("shopDomain", "presentmentCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "CartFixture_shopDomain_signature_key" ON "CartFixture"("shopDomain", "signature");

-- CreateIndex
CREATE UNIQUE INDEX "FixtureBaseline_fixtureId_key" ON "FixtureBaseline"("fixtureId");
