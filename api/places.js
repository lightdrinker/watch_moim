export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, query, photo_references, maxwidth = 600 } = req.query;

  // Gemini API 프록시
  if (action === 'gemini') {
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Gemini API key not configured' });
    try {
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        req.on('error', reject);
      });

      const { prompt } = body;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1200 }
        })
      });
      const data = await r.json();
      // Gemini 응답에서 텍스트 추출해서 일관된 형태로 반환
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.status(200).json({ text });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    if (action === 'search') {
      const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&language=ko&region=kr&key=${API_KEY}`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();
      if (!searchData.results || searchData.results.length === 0) return res.status(200).json({ results: [] });

      const top = searchData.results.slice(0, 10);
      const fields = 'name,rating,user_ratings_total,formatted_address,photos,price_level,opening_hours,place_id,types';
      const details = await Promise.all(top.map(async (place) => {
        try {
          const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=${fields}&language=ko&key=${API_KEY}`;
          const detailRes = await fetch(detailUrl);
          const detailData = await detailRes.json();
          return detailData.result || place;
        } catch { return place; }
      }));
      return res.status(200).json({ results: details });
    }

    if (action === 'photo') {
      const refs = (photo_references || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 2);
      const urls = await Promise.all(refs.map(async (ref) => {
        try {
          const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photo_reference=${ref}&key=${API_KEY}`;
          const r = await fetch(url, { redirect: 'follow' });
          return r.url || null;
        } catch { return null; }
      }));
      return res.status(200).json({ photo_urls: urls.filter(Boolean) });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
