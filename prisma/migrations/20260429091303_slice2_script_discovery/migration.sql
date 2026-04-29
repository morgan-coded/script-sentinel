-- CreateTable
CREATE TABLE "DiscoveredScript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scriptType" TEXT NOT NULL DEFAULT 'unknown',
    "source" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" DATETIME,
    "origin" TEXT NOT NULL DEFAULT 'paste',
    "externalId" TEXT,
    "shopifyUpdatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiscoveredScript_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop" ("myshopifyDomain") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScriptClassification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scriptId" TEXT NOT NULL,
    "autoCategory" TEXT NOT NULL,
    "autoConfidence" REAL NOT NULL,
    "autoSignals" TEXT NOT NULL DEFAULT '[]',
    "overrideCategory" TEXT,
    "overrideReason" TEXT,
    "overrideUpdatedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScriptClassification_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "DiscoveredScript" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DiscoveredScript_shopDomain_isActive_idx" ON "DiscoveredScript"("shopDomain", "isActive");

-- CreateIndex
CREATE INDEX "DiscoveredScript_shopDomain_scriptType_idx" ON "DiscoveredScript"("shopDomain", "scriptType");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptClassification_scriptId_key" ON "ScriptClassification"("scriptId");
