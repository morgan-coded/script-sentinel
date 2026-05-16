-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "myshopifyDomain" TEXT NOT NULL,
    "shopName" TEXT,
    "isPlus" BOOLEAN NOT NULL DEFAULT false,
    "isDevelopment" BOOLEAN NOT NULL DEFAULT false,
    "planDisplayName" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("myshopifyDomain")
);

-- CreateTable
CREATE TABLE "Charge" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "shopifyChargeGid" TEXT,
    "confirmationUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredScript" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scriptType" TEXT NOT NULL DEFAULT 'unknown',
    "source" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "origin" TEXT NOT NULL DEFAULT 'paste',
    "externalId" TEXT,
    "shopifyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredScript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptClassification" (
    "id" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "autoCategory" TEXT NOT NULL,
    "autoConfidence" DOUBLE PRECISION NOT NULL,
    "autoSignals" TEXT NOT NULL DEFAULT '[]',
    "overrideCategory" TEXT,
    "overrideReason" TEXT,
    "overrideUpdatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptClassification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartFixture" (
    "id" TEXT NOT NULL,
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
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartFixture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixtureBaseline" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "totalDiscountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discountApplications" TEXT NOT NULL DEFAULT '[]',
    "shippingRateCode" TEXT,
    "shippingRateTitle" TEXT,
    "shippingRateAmount" DOUBLE PRECISION,
    "paymentGatewayNames" TEXT NOT NULL DEFAULT '[]',
    "cartTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixtureBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditPurchase" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "shopifyChargeGid" TEXT,
    "confirmationUrl" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AuditPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditReport" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'single',
    "snapshot" TEXT NOT NULL,
    "scriptCount" INTEGER NOT NULL DEFAULT 0,
    "fixtureCount" INTEGER NOT NULL DEFAULT 0,
    "highRiskCount" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filename" TEXT NOT NULL,

    CONSTRAINT "AuditReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredFunction" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "apiType" TEXT NOT NULL,
    "apiVersion" TEXT,
    "appTitle" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredFunction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptureRun" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "windowFromAt" TIMESTAMP(3) NOT NULL,
    "windowToAt" TIMESTAMP(3) NOT NULL,
    "ordersExamined" INTEGER NOT NULL DEFAULT 0,
    "outputsCaptured" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,

    CONSTRAINT "CaptureRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunctionOutput" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "captureRunId" TEXT NOT NULL,
    "functionId" TEXT,
    "sourceOrderGid" TEXT NOT NULL,
    "fixtureSignature" TEXT NOT NULL,
    "observedDiscountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "observedShippingCode" TEXT,
    "observedShippingTitle" TEXT,
    "observedShippingAmount" DOUBLE PRECISION,
    "observedPaymentGateways" TEXT NOT NULL DEFAULT '[]',
    "observedDiscountCodes" TEXT NOT NULL DEFAULT '[]',
    "cartTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "presentmentCurrency" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FunctionOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriftRun" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "fixturesExamined" INTEGER NOT NULL DEFAULT 0,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "driftCount" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "infoCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,

    CONSTRAINT "DriftRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriftResult" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "driftRunId" TEXT NOT NULL,
    "fixtureSignature" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "categories" TEXT NOT NULL DEFAULT '[]',
    "message" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "baselineSummary" TEXT NOT NULL DEFAULT '{}',
    "outputSummary" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriftResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegressionRun" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'cron',
    "driftRunId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fixturesExamined" INTEGER NOT NULL DEFAULT 0,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "driftCount" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "newCriticalCount" INTEGER NOT NULL DEFAULT 0,
    "newWarningCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "RegressionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriftAlert" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "regressionRunId" TEXT NOT NULL,
    "fixtureSignature" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "previousSeverity" TEXT NOT NULL DEFAULT 'none',
    "summary" TEXT NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriftAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Charge_shopifyChargeGid_key" ON "Charge"("shopifyChargeGid");

-- CreateIndex
CREATE INDEX "Charge_shopDomain_status_idx" ON "Charge"("shopDomain", "status");

-- CreateIndex
CREATE INDEX "Charge_planKey_idx" ON "Charge"("planKey");

-- CreateIndex
CREATE INDEX "DiscoveredScript_shopDomain_isActive_idx" ON "DiscoveredScript"("shopDomain", "isActive");

-- CreateIndex
CREATE INDEX "DiscoveredScript_shopDomain_scriptType_idx" ON "DiscoveredScript"("shopDomain", "scriptType");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptClassification_scriptId_key" ON "ScriptClassification"("scriptId");

-- CreateIndex
CREATE INDEX "CartFixture_shopDomain_lastObservedAt_idx" ON "CartFixture"("shopDomain", "lastObservedAt");

-- CreateIndex
CREATE INDEX "CartFixture_shopDomain_presentmentCurrency_idx" ON "CartFixture"("shopDomain", "presentmentCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "CartFixture_shopDomain_signature_key" ON "CartFixture"("shopDomain", "signature");

-- CreateIndex
CREATE UNIQUE INDEX "FixtureBaseline_fixtureId_key" ON "FixtureBaseline"("fixtureId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditPurchase_shopifyChargeGid_key" ON "AuditPurchase"("shopifyChargeGid");

-- CreateIndex
CREATE INDEX "AuditPurchase_shopDomain_status_idx" ON "AuditPurchase"("shopDomain", "status");

-- CreateIndex
CREATE INDEX "AuditReport_shopDomain_generatedAt_idx" ON "AuditReport"("shopDomain", "generatedAt");

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

-- CreateIndex
CREATE INDEX "DriftRun_shopDomain_startedAt_idx" ON "DriftRun"("shopDomain", "startedAt");

-- CreateIndex
CREATE INDEX "DriftResult_shopDomain_severity_idx" ON "DriftResult"("shopDomain", "severity");

-- CreateIndex
CREATE INDEX "DriftResult_shopDomain_fixtureSignature_idx" ON "DriftResult"("shopDomain", "fixtureSignature");

-- CreateIndex
CREATE INDEX "DriftResult_driftRunId_idx" ON "DriftResult"("driftRunId");

-- CreateIndex
CREATE INDEX "RegressionRun_shopDomain_startedAt_idx" ON "RegressionRun"("shopDomain", "startedAt");

-- CreateIndex
CREATE INDEX "DriftAlert_shopDomain_createdAt_idx" ON "DriftAlert"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "DriftAlert_regressionRunId_idx" ON "DriftAlert"("regressionRunId");

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredScript" ADD CONSTRAINT "DiscoveredScript_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptClassification" ADD CONSTRAINT "ScriptClassification_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "DiscoveredScript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartFixture" ADD CONSTRAINT "CartFixture_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixtureBaseline" ADD CONSTRAINT "FixtureBaseline_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "CartFixture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPurchase" ADD CONSTRAINT "AuditPurchase_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditReport" ADD CONSTRAINT "AuditReport_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditReport" ADD CONSTRAINT "AuditReport_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "AuditPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredFunction" ADD CONSTRAINT "DiscoveredFunction_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptureRun" ADD CONSTRAINT "CaptureRun_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunctionOutput" ADD CONSTRAINT "FunctionOutput_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunctionOutput" ADD CONSTRAINT "FunctionOutput_captureRunId_fkey" FOREIGN KEY ("captureRunId") REFERENCES "CaptureRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunctionOutput" ADD CONSTRAINT "FunctionOutput_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "DiscoveredFunction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriftRun" ADD CONSTRAINT "DriftRun_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriftResult" ADD CONSTRAINT "DriftResult_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriftResult" ADD CONSTRAINT "DriftResult_driftRunId_fkey" FOREIGN KEY ("driftRunId") REFERENCES "DriftRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegressionRun" ADD CONSTRAINT "RegressionRun_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriftAlert" ADD CONSTRAINT "DriftAlert_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriftAlert" ADD CONSTRAINT "DriftAlert_regressionRunId_fkey" FOREIGN KEY ("regressionRunId") REFERENCES "RegressionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
