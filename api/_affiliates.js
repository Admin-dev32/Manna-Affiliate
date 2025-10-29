// /api/_affiliates.js
export function getAffiliatesMap(){
  const raw = process.env.AFFILIATES_JSON || '';
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  // Fallback dev (borra/ajusta en prod si quieres)
  return {
    "1234": {
      id: "dev-jorge",
      name: "Jorge (DEV)",
      bundleRate: 0.7,
      fountainCommission: 50,
      commissionsByPkg: {
        "50-150-5h": 80,
        "150-250-5h": 100,
        "250-350-6h": 130
      }
    }
  };
}

export function resolveAffiliate(pin){
  const map = getAffiliatesMap();
  const key = String(pin ?? '').trim();
  const aff = key && map[key] ? map[key] : null;
  if(!aff) return null;
  return {
    id: aff.id || key,
    name: aff.name || 'Affiliate',
    bundleRate: typeof aff.bundleRate === 'number' ? aff.bundleRate : 0.7,
    commissionsByPkg: aff.commissionsByPkg || { "50-150-5h":0, "150-250-5h":0, "250-350-6h":0 },
    fountainCommission: typeof aff.fountainCommission === 'number' ? aff.fountainCommission : 50
  };
}

export function calcAffiliateCommissions(aff, { pkg, secondEnabled, fountainEnabled }){
  const main = Math.max(0, Number(aff.commissionsByPkg?.[pkg] || 0));
  const second = secondEnabled ? Math.round(main * (aff.bundleRate || 0.7)) : 0;
  const fountain = fountainEnabled ? Math.max(0, Number(aff.fountainCommission || 0)) : 0;
  const totalCommission = main + second + fountain;
  return { main, second, fountain, totalCommission };
}
