-- Briefs gravados pelo fallback antigo nasceram COMPLETE por default.
-- Rebaixa para PARTIAL para a UI não tratar texto operacional genérico como insight.
UPDATE "DealBrief"
SET "analysisQuality" = 'PARTIAL'
WHERE "analysisQuality" = 'COMPLETE'
  AND (
    "nextAction" ILIKE '%releia a conversa%'
    OR "nextAction" ILIKE '%confirme o próximo passo%'
    OR "contextSummary" ILIKE '%extração automática não fechou%'
    OR "contextSummary" ILIKE '%mensagem do produtor recebida%'
  );
