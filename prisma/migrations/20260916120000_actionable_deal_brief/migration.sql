-- CreateEnum
CREATE TYPE "NextActionOwner" AS ENUM ('RTV', 'MANAGER');

-- CreateEnum
CREATE TYPE "AnalysisQuality" AS ENUM ('COMPLETE', 'PARTIAL', 'STALE');

-- AlterTable
ALTER TABLE "DealBrief"
ADD COLUMN "producerPosition" TEXT,
ADD COLUMN "dealChange" TEXT,
ADD COLUMN "nextActionReason" TEXT,
ADD COLUMN "nextActionOwner" "NextActionOwner" NOT NULL DEFAULT 'RTV',
ADD COLUMN "nextActionDueHint" TEXT,
ADD COLUMN "suggestedReply" TEXT,
ADD COLUMN "managerGuidance" TEXT,
ADD COLUMN "analysisQuality" "AnalysisQuality" NOT NULL DEFAULT 'COMPLETE';
