-- CreateTable
CREATE TABLE "RegressionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'cron',
    "driftRunId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fixturesExamined" INTEGER NOT NULL DEFAULT 0,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "driftCount" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "newCriticalCount" INTEGER NOT NULL DEFAULT 0,
    "newWarningCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    CONSTRAINT "RegressionRun_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DriftAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "regressionRunId" TEXT NOT NULL,
    "fixtureSignature" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "previousSeverity" TEXT NOT NULL DEFAULT 'none',
    "summary" TEXT NOT NULL,
    "dispatchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DriftAlert_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DriftAlert_regressionRunId_fkey" FOREIGN KEY ("regressionRunId") REFERENCES "RegressionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RegressionRun_shopDomain_startedAt_idx" ON "RegressionRun"("shopDomain", "startedAt");

-- CreateIndex
CREATE INDEX "DriftAlert_shopDomain_createdAt_idx" ON "DriftAlert"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "DriftAlert_regressionRunId_idx" ON "DriftAlert"("regressionRunId");
