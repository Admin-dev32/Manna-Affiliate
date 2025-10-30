// /api/oauth.js
export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    const {
      GOOGLE_OAUTH_CLIENT_ID: clientId,
      GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
      GOOGLE_OAUTH_REDIRECT_URI: redirectUri,
    } = process.env;

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).json({
        ok: false,
        error: 'Missing GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI env vars',
      });
    }

    // If Google sent us back with a ?code=..., exchange it for tokens
    const { code } = req.query || {};
    if (code) {
      const tokenUrl = 'https://oauth2.googleapis.com/token';
      const body = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });

      const r = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const j = await r.json();

      if (!r.ok) {
        return res.status(400).json({ ok: false, error: j.error || j });
      }

      const { refresh_token, access_token, expires_in } = j;
      return res.status(200).json({
        ok: true,
        message: refresh_token
          ? 'Copy the refresh_token below and save it as GOOGLE_OAUTH_REFRESH_TOKEN in Vercel env vars, then redeploy.'
          : 'No refresh_token returned. If you previously granted access, append &prompt=consent to force a new token.',
        refresh_token: refresh_token || null,
        received: { access_token, expires_in },
      });
    }

    // Otherwise, start the OAuth flow (redirect to Google)
    const authBase = 'https://accounts.google.com/o/oauth2/v2/auth';
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',      // get refresh_token
      prompt: 'consent',           // force refresh_token the first time
      scope: 'https://www.googleapis.com/auth/calendar',
    });

    res.writeHead(302, { Location: `${authBase}?${params.toString()}` });
    res.end();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
