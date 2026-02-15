CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false
);

CREATE TABLE "MigrationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "sourceToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "modules" TEXT NOT NULL DEFAULT 'all',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "currentModule" TEXT,
    "totalModules" INTEGER NOT NULL DEFAULT 0,
    "doneModules" INTEGER NOT NULL DEFAULT 0,
    "logs" TEXT NOT NULL DEFAULT '[]',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

CREATE INDEX "MigrationJob_shop_idx" ON "MigrationJob"("shop");
CREATE INDEX "MigrationJob_status_idx" ON "MigrationJob"("status");
