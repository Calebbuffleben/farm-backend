-- CreateEnum
CREATE TYPE "InterventionTrigger" AS ENUM ('MANAGER_OWNER', 'ESCALATE', 'COOLING_CLOSE', 'PRICE_OVER_AUTHORITY', 'COMPETITOR_LATE');

-- CreateEnum
CREATE TYPE "InterventionStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'EXECUTED', 'DISMISSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InterventionDecision" AS ENUM ('ASSUME', 'DELEGATE', 'DISMISS');

-- CreateEnum
CREATE TYPE "InterventionMovement" AS ENUM ('FAVORABLE', 'NONE', 'UNFAVORABLE');

-- CreateTable
CREATE TABLE "ManagerIntervention" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "trigger" "InterventionTrigger" NOT NULL,
    "evidenceMessageId" TEXT,
    "stage" "DealStage" NOT NULL,
    "temperature" TEXT NOT NULL,
    "intent" "DealLevel" NOT NULL,
    "urgency" "DealLevel" NOT NULL,
    "stageConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "analysisQuality" "AnalysisQuality" NOT NULL DEFAULT 'COMPLETE',
    "blockerSubtype" TEXT,
    "recommendedAction" TEXT NOT NULL,
    "recommendedKind" TEXT NOT NULL,
    "recommendedOwner" "NextActionOwner" NOT NULL DEFAULT 'RTV',
    "dueAt" TIMESTAMP(3),
    "managerGuidance" TEXT,
    "moneyHints" JSONB,
    "rtvUserId" TEXT,
    "status" "InterventionStatus" NOT NULL DEFAULT 'OPEN',
    "decision" "InterventionDecision",
    "assigneeUserId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "executionObservedAt" TIMESTAMP(3),
    "executionMessageId" TEXT,
    "executionChannel" "ChannelKind",
    "producerRepliedAt" TIMESTAMP(3),
    "movement" "InterventionMovement",
    "movementNote" TEXT,
    "movementAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagerIntervention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "stage" "DealStage" NOT NULL,
    "temperature" TEXT NOT NULL,
    "intent" "DealLevel" NOT NULL,
    "urgency" "DealLevel" NOT NULL,
    "blockerSubtype" TEXT,
    "evidenceMessageId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardVisit" (
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "visitStartedAt" TIMESTAMP(3) NOT NULL,
    "visibleSinceAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardVisit_pkey" PRIMARY KEY ("tenantId","userId")
);

-- CreateIndex
CREATE INDEX "ManagerIntervention_tenantId_status_createdAt_idx" ON "ManagerIntervention"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ManagerIntervention_tenantId_conversationId_trigger_idx" ON "ManagerIntervention"("tenantId", "conversationId", "trigger");

-- CreateIndex
CREATE INDEX "ManagerIntervention_tenantId_createdAt_idx" ON "ManagerIntervention"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "DealSnapshot_tenantId_conversationId_occurredAt_idx" ON "DealSnapshot"("tenantId", "conversationId", "occurredAt");

-- CreateIndex
CREATE INDEX "DealSnapshot_tenantId_occurredAt_idx" ON "DealSnapshot"("tenantId", "occurredAt");

-- AddForeignKey
ALTER TABLE "ManagerIntervention" ADD CONSTRAINT "ManagerIntervention_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerIntervention" ADD CONSTRAINT "ManagerIntervention_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerIntervention" ADD CONSTRAINT "ManagerIntervention_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerIntervention" ADD CONSTRAINT "ManagerIntervention_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealSnapshot" ADD CONSTRAINT "DealSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealSnapshot" ADD CONSTRAINT "DealSnapshot_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardVisit" ADD CONSTRAINT "DashboardVisit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardVisit" ADD CONSTRAINT "DashboardVisit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
