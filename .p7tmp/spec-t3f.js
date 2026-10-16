module.exports = [
  { file: 'scripts/acceptance/lookup-acceptance.ts', edits: [[ "import { estimateCallCostUsd, PRICING_CHECKED_ON } from '../../services/enrichment/pricing';", "import { estimateCallCostUsd } from '../../services/enrichment/pricing';" ]] },
];
