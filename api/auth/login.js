// /api/auth/login.js
export const config = { runtime: 'nodejs' };

const AFFILIATES = {
  // EJEMPLOS — cámbialos por tus PINs reales
  '1111': {
    id: 'aff-001',
    name: 'Basem',
    bundleRate: 0.7,                           // 70% de la comisión del 2° bar
    fountainCommission: 50,                    // comisión fija por fuente
    commissionsByPkg: {                        // comisión por paquete principal
      '50-150-5h': 80,
      '150-250-5h': 100,
      '250-350-6h': 130
    }
  },
  '2222': {
    id: 'aff-002',
    name: 'Jeimy',
    bundleRate: 0.7,
    fountainCommission: 50,
    commissionsByPkg: {
      '50-150-5h': 90,
      '150-250-5h': 110,
      '250-350-6h': 140
    }
  }
};

export default async function handler(req, res){
  // CORS básico
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;
  if (req.method === 'OPTIONS'){
    res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method !== 'POST') return res.status(405).json({ ok:false, error: 'Method not allowed' });

  try{
    const { pin } = req.body || {};
    if(!pin) return res.status(400).json({ ok:false, error:'PIN required' });
    const affiliate = AFFILIATES[String(pin)];
    if(!affiliate) return res.status(200).json({ ok:false, error:'Invalid PIN' });
    return res.json({ ok:true, affiliate });
  }catch(e){
    return res.status(500).json({ ok:false, error:e.message });
  }
}
