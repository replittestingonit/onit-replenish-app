-- CreateTable
CREATE TABLE "AppConfiguration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "businessStart" TEXT NOT NULL DEFAULT '09:00',
    "businessEnd" TEXT NOT NULL DEFAULT '17:00',
    "emailAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertEmailAddress" TEXT,
    "strictInventory" BOOLEAN NOT NULL DEFAULT false,
    "requireReason" BOOLEAN NOT NULL DEFAULT false,
    "requireInboundReference" BOOLEAN NOT NULL DEFAULT false,
    "staffNames" TEXT NOT NULL DEFAULT '[]',
    "adjustmentReasons" TEXT NOT NULL DEFAULT '["Damaged Item","Cycle Count Correction","Customer Return"]',
    "evidenceStorage" TEXT NOT NULL DEFAULT 'email',
    "googleDriveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "googleDriveFolderId" TEXT,
    "googleDriveAccessToken" TEXT,
    "googleDriveRefreshToken" TEXT,
    "googleDriveTokenExpiry" DATETIME,
    "googleDriveEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SecurityRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggerType" TEXT NOT NULL,
    "timeOpen" TEXT,
    "timeClose" TEXT,
    "quantityThreshold" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TriggeredAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ruleId" TEXT NOT NULL,
    "person" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "transactionId" TEXT,
    CONSTRAINT "TriggeredAlert_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SecurityRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventoryEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inventoryItemId" TEXT NOT NULL,
    "available" INTEGER NOT NULL,
    "reason" TEXT,
    "transactionId" TEXT,
    "isProtected" BOOLEAN NOT NULL DEFAULT false,
    "isFullyMet" BOOLEAN,
    "proofImage" TEXT,
    "referenceNumber" TEXT
);

-- CreateTable
CREATE TABLE "OrderReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inventoryItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "orderId" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AppConfiguration_shop_key" ON "AppConfiguration"("shop");
