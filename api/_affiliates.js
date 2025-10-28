// /api/_affiliates.js
export function getAffiliatesMap(){
  let raw = process.env.AFFILIATES_JSON || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

export function resolveAffiliate(pin){
  const map = getAffiliatesMap();
  const aff = map[pin];
  if(!aff) return null;
  // normaliza faltantes
  return {
    id: aff.id || pin,
    name: aff.name || 'Affiliate',
    bundleRate: typeof aff.bundleRate === 'number' ? aff.bundleRate : 0.7,
    commissionsByPkg: aff.commissionsByPkg || { "50-150-5h":0, "150-250-5h":0, "250-350-6h":0 }
  };
}

// Calcula comisiones para la orden
export function calcAffiliateCommissions(aff, { pkg, secondEnabled }){
  const main = Math.max(0, Number(aff.commissionsByPkg?.[pkg] || 0));
  const second = secondEnabled ? Math.round(main * (aff.bundleRate || 0.7)) : 0;
  const totalCommission = main + second;
  return { main, second, totalCommission };
}
