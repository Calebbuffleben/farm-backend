-- Billing catalog: Starter / Growth / Scale / Enterprise.
-- PRO legado vira GROWTH. FREE permanece para tenants ainda não migrados.

CREATE TYPE "Plan_new" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'SCALE', 'ENTERPRISE');

ALTER TABLE "Subscription" ALTER COLUMN "plan" DROP DEFAULT;

ALTER TABLE "Subscription"
  ALTER COLUMN "plan" TYPE "Plan_new"
  USING (
    CASE
      WHEN "plan"::text = 'PRO' THEN 'GROWTH'::"Plan_new"
      WHEN "plan"::text = 'ENTERPRISE' THEN 'ENTERPRISE'::"Plan_new"
      ELSE 'FREE'::"Plan_new"
    END
  );

ALTER TABLE "PendingCheckout"
  ALTER COLUMN "plan" TYPE "Plan_new"
  USING (
    CASE
      WHEN "plan"::text = 'PRO' THEN 'GROWTH'::"Plan_new"
      WHEN "plan"::text = 'ENTERPRISE' THEN 'ENTERPRISE'::"Plan_new"
      ELSE 'FREE'::"Plan_new"
    END
  );

ALTER TABLE "Subscription" ALTER COLUMN "plan" SET DEFAULT 'FREE'::"Plan_new";

DROP TYPE "Plan";
ALTER TYPE "Plan_new" RENAME TO "Plan";

UPDATE "Subscription"
SET "maxUsers" = 10
WHERE "plan" = 'GROWTH' AND "maxUsers" < 10;

ALTER TABLE "Subscription" ADD COLUMN "pendingPlan" "Plan";
ALTER TABLE "Subscription" ADD COLUMN "pendingMaxUsers" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "seatLimitHoldReason" TEXT;
