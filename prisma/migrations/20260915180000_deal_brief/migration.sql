-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('SONDAGEM', 'NEGOCIACAO', 'FECHAMENTO', 'POS_VENDA', 'SEM_NEGOCIO');

-- CreateEnum
CREATE TYPE "DealLevel" AS ENUM ('BAIXA', 'MEDIA', 'ALTA');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "salesPolicy" JSONB;

-- CreateTable
CREATE TABLE "DealBrief" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "producerId" TEXT,
    "rtvUserId" TEXT,
    "stage" "DealStage" NOT NULL DEFAULT 'SEM_NEGOCIO',
    "stageConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "contextSummary" TEXT NOT NULL,
    "intent" "DealLevel" NOT NULL DEFAULT 'MEDIA',
    "urgency" "DealLevel" NOT NULL DEFAULT 'MEDIA',
    "painPoint" TEXT,
    "nextAction" TEXT NOT NULL,
    "nextActionKind" TEXT NOT NULL DEFAULT 'aguardar',
    "nextActionDueAt" TIMESTAMP(3),
    "blockerSubtype" TEXT,
    "products" JSONB,
    "evidenceMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DealBrief_conversationId_key" ON "DealBrief"("conversationId");

-- CreateIndex
CREATE INDEX "DealBrief_tenantId_stage_idx" ON "DealBrief"("tenantId", "stage");

-- CreateIndex
CREATE INDEX "DealBrief_tenantId_rtvUserId_idx" ON "DealBrief"("tenantId", "rtvUserId");

-- CreateIndex
CREATE INDEX "DealBrief_tenantId_producerId_idx" ON "DealBrief"("tenantId", "producerId");

-- AddForeignKey
ALTER TABLE "DealBrief" ADD CONSTRAINT "DealBrief_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealBrief" ADD CONSTRAINT "DealBrief_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
