// /api/_affiliates.js
export function getAffiliatesMap(){
  let raw = process.env.AFFILIATES_JSON || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

export function resolveAffiliate(pin){
  const map = getAffiliatesMap();
  const aff = map[String(pin||'').trim()];
  if(!aff) return null;
  return {
    id: aff.id || pin,
    name: aff.name || 'Affiliate',
    bundleRate: typeof aff.bundleRate === 'number' ? aff.bundleRate : 0.7,
    // commissions by package-size (main bar)
    commissionsByPkg: aff.commissionsByPkg || { "50-150-5h":0, "150-250-5h":0, "250-350-6h":0 },
    // flat commission for chocolate fountain (global rule = $50 if not provided)
    fountainCommission: typeof aff.fountainCommission === 'number' ? aff.fountainCommission : 50
  };
}

/**
 * Calculate affiliate commissions for this order.
 * - main: from package size
 * - second: bundle commission = main * bundleRate (if second bar enabled)
 * - fountain: flat commission if fountainEnabled
 */
export function calcAffiliateCommissions(aff, { pkg, secondEnabled, fountainEnabled }){
  const main = Math.max(0, Number(aff.commissionsByPkg?.[pkg] || 0));
  const second = secondEnabled ? Math.round(main * (aff.bundleRate || 0.7)) : 0;
  const fountain = fountainEnabled ? Math.max(0, Number(aff.fountainCommission || 0)) : 0;
  const totalCommission = main + second + fountain;
  return { main, second, fountain, totalCommission };
}
