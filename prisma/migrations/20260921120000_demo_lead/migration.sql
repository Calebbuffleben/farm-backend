-- Landing / Google Ads: pedidos de demonstração (ainda não são Tenant).

CREATE TYPE "DemoLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'DISMISSED');

CREATE TABLE "DemoLead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "status" "DemoLeadStatus" NOT NULL DEFAULT 'NEW',
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "gclid" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoLead_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DemoLead_email_createdAt_idx" ON "DemoLead"("email", "createdAt");
CREATE INDEX "DemoLead_status_createdAt_idx" ON "DemoLead"("status", "createdAt");
