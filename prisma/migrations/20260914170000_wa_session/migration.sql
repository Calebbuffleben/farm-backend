-- AlterEnum
ALTER TYPE "ChannelKind" ADD VALUE 'WA_SESSION';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "reportOptOutAt" TIMESTAMP(3);
