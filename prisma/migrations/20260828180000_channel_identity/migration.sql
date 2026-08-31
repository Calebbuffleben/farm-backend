-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('WABA', 'VOICE', 'EMAIL');

-- CreateEnum
CREATE TYPE "ChannelAccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "phone" TEXT;

-- CreateTable
CREATE TABLE "ChannelAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "ChannelKind" NOT NULL,
    "credentialsEncrypted" TEXT,
    "webhookSecret" TEXT,
    "status" "ChannelAccountStatus" NOT NULL DEFAULT 'PENDING',
    "wabaAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelEndpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelAccountId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "displayAddress" TEXT NOT NULL,
    "assignedUserId" TEXT,
    "wabaNumberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProducerEmail" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "producerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProducerEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAccount_wabaAccountId_key" ON "ChannelAccount"("wabaAccountId");

-- CreateIndex
CREATE INDEX "ChannelAccount_tenantId_idx" ON "ChannelAccount"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelEndpoint_wabaNumberId_key" ON "ChannelEndpoint"("wabaNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelEndpoint_channelAccountId_address_key" ON "ChannelEndpoint"("channelAccountId", "address");

-- CreateIndex
CREATE INDEX "ChannelEndpoint_tenantId_idx" ON "ChannelEndpoint"("tenantId");

-- CreateIndex
CREATE INDEX "ChannelEndpoint_assignedUserId_idx" ON "ChannelEndpoint"("assignedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ProducerEmail_tenantId_email_key" ON "ProducerEmail"("tenantId", "email");

-- CreateIndex
CREATE INDEX "ProducerEmail_producerId_idx" ON "ProducerEmail"("producerId");

-- AddForeignKey
ALTER TABLE "ChannelAccount" ADD CONSTRAINT "ChannelAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAccount" ADD CONSTRAINT "ChannelAccount_wabaAccountId_fkey" FOREIGN KEY ("wabaAccountId") REFERENCES "WabaAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelEndpoint" ADD CONSTRAINT "ChannelEndpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelEndpoint" ADD CONSTRAINT "ChannelEndpoint_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelEndpoint" ADD CONSTRAINT "ChannelEndpoint_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelEndpoint" ADD CONSTRAINT "ChannelEndpoint_wabaNumberId_fkey" FOREIGN KEY ("wabaNumberId") REFERENCES "WabaNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProducerEmail" ADD CONSTRAINT "ProducerEmail_producerId_fkey" FOREIGN KEY ("producerId") REFERENCES "Producer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: cada WabaAccount vira ChannelAccount kind=WABA
INSERT INTO "ChannelAccount" ("id", "tenantId", "kind", "webhookSecret", "status", "wabaAccountId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       "tenantId",
       'WABA',
       "webhookSecret",
       CASE "status"
           WHEN 'ACTIVE' THEN 'ACTIVE'::"ChannelAccountStatus"
           WHEN 'DISABLED' THEN 'DISABLED'::"ChannelAccountStatus"
           ELSE 'PENDING'::"ChannelAccountStatus"
       END,
       "id",
       "createdAt",
       "updatedAt"
FROM "WabaAccount";

-- Backfill: cada WabaNumber vira ChannelEndpoint
INSERT INTO "ChannelEndpoint" ("id", "tenantId", "channelAccountId", "address", "displayAddress", "assignedUserId", "wabaNumberId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       wa."tenantId",
       ca."id",
       wn."phoneNumberId",
       wn."displayNumber",
       wn."assignedUserId",
       wn."id",
       wn."createdAt",
       wn."updatedAt"
FROM "WabaNumber" wn
JOIN "WabaAccount" wa ON wa."id" = wn."wabaAccountId"
JOIN "ChannelAccount" ca ON ca."wabaAccountId" = wa."id";

-- Conversation: identidade (endpoint, peer)
ALTER TABLE "Conversation" ADD COLUMN "channelEndpointId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "peerAddress" TEXT;

UPDATE "Conversation" c
SET "channelEndpointId" = e."id",
    "peerAddress" = c."producerPhone"
FROM "ChannelEndpoint" e
WHERE e."wabaNumberId" = c."wabaNumberId";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Conversation" WHERE "channelEndpointId" IS NULL OR "peerAddress" IS NULL
  ) THEN
    RAISE EXCEPTION 'channel backfill left Conversation rows without endpoint/peer';
  END IF;
END $$;

ALTER TABLE "Conversation" ALTER COLUMN "channelEndpointId" SET NOT NULL;
ALTER TABLE "Conversation" ALTER COLUMN "peerAddress" SET NOT NULL;

DROP INDEX "Conversation_wabaNumberId_producerPhone_key";

ALTER TABLE "Conversation" ALTER COLUMN "wabaNumberId" DROP NOT NULL;
ALTER TABLE "Conversation" ALTER COLUMN "producerPhone" DROP NOT NULL;

ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_wabaNumberId_fkey";
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_wabaNumberId_fkey" FOREIGN KEY ("wabaNumberId") REFERENCES "WabaNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_channelEndpointId_fkey" FOREIGN KEY ("channelEndpointId") REFERENCES "ChannelEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Conversation_channelEndpointId_peerAddress_key" ON "Conversation"("channelEndpointId", "peerAddress");
