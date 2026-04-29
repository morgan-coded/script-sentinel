-- CreateTable
CREATE TABLE "DriftRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "fixturesExamined" INTEGER NOT NULL DEFAULT 0,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "driftCount" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "infoCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    CONSTRAINT "DriftRun_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DriftResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "driftRunId" TEXT NOT NULL,
    "fixtureSignature" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "categories" TEXT NOT NULL DEFAULT '[]',
    "message" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "baselineSummary" TEXT NOT NULL DEFAULT '{}',
    "outputSummary" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DriftResult_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DriftResult_driftRunId_fkey" FOREIGN KEY ("driftRunId") REFERENCES "DriftRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DriftRun_shopDomain_startedAt_idx" ON "DriftRun"("shopDomain", "startedAt");

-- CreateIndex
CREATE INDEX "DriftResult_shopDomain_severity_idx" ON "DriftResult"("shopDomain", "severity");

-- CreateIndex
CREATE INDEX "DriftResult_shopDomain_fixtureSignature_idx" ON "DriftResult"("shopDomain", "fixtureSignature");

-- CreateIndex
CREATE INDEX "DriftResult_driftRunId_idx" ON "DriftResult"("driftRunId");
