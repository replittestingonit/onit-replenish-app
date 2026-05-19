-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AppConfiguration" (
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
    "adjustmentReasons" TEXT NOT NULL DEFAULT '["Damaged Item","Cycle Count Correction","Customer Return","New Inventory Received"]',
    "privateEvidenceMode" BOOLEAN NOT NULL DEFAULT false,
    "onitVisionApiKey" TEXT,
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
INSERT INTO "new_AppConfiguration" ("adjustmentReasons", "alertEmailAddress", "businessEnd", "businessStart", "createdAt", "emailAlertsEnabled", "evidenceStorage", "googleDriveAccessToken", "googleDriveEmail", "googleDriveEnabled", "googleDriveFolderId", "googleDriveRefreshToken", "googleDriveTokenExpiry", "id", "onitVisionApiKey", "privateEvidenceMode", "requireInboundReference", "requireReason", "shop", "staffNames", "strictInventory", "updatedAt") SELECT "adjustmentReasons", "alertEmailAddress", "businessEnd", "businessStart", "createdAt", "emailAlertsEnabled", "evidenceStorage", "googleDriveAccessToken", "googleDriveEmail", "googleDriveEnabled", "googleDriveFolderId", "googleDriveRefreshToken", "googleDriveTokenExpiry", "id", "onitVisionApiKey", "privateEvidenceMode", "requireInboundReference", "requireReason", "shop", "staffNames", "strictInventory", "updatedAt" FROM "AppConfiguration";
DROP TABLE "AppConfiguration";
ALTER TABLE "new_AppConfiguration" RENAME TO "AppConfiguration";
CREATE UNIQUE INDEX "AppConfiguration_shop_key" ON "AppConfiguration"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
