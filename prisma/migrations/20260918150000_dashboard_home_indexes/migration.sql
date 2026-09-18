-- CreateIndex
CREATE INDEX "DealBrief_tenantId_updatedAt_idx" ON "DealBrief"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "CommercialFact_tenantId_status_occurredAt_idx" ON "CommercialFact"("tenantId", "status", "occurredAt");
