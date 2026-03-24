export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, query, photo_references, maxwidth = 600 } = req.query;

  // Gemini API 프록시 — req.body로 바로 접근 (Vercel이 자동 파싱)
  if (action === 'gemini') {
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Gemini API key not configured' });
    try {
      const prompt = req.body?.prompt || '';
      if (!prompt) return res.status(400).json({ error: 'No prompt provided' });

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { 
            temperature: 0.7, 
            maxOutputTokens: 1500,
            // [Review Point] JSON 포맷 강제. 프론트엔드 파싱 에러를 원천 차단합니다.
            responseMimeType: "application/json" 
          }
        })
      });
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.status(200).json({ text });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Google API key not configured' });

  try {
    // 식당 검색 + 상세정보 병렬 조회
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

    // Geocoding — 텍스트 주소를 좌표로 변환
    if (action === 'geocode') {
      const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&language=ko&region=kr&key=${API_KEY}`;
      const geocodeRes = await fetch(geocodeUrl);
      const geocodeData = await geocodeRes.json();
      if (!geocodeData.results || geocodeData.results.length === 0) return res.status(200).json({ lat: null, lng: null });
      const loc = geocodeData.results[0].geometry.location;
      return res.status(200).json({ lat: loc.lat, lng: loc.lng });
    }

    // 좌표 기반 주변 식당 검색
    if (action === 'nearby') {
      const { lat, lng, keyword } = req.query;
      const nearbyUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(keyword)}&location=${lat},${lng}&radius=1000&language=ko&region=kr&key=${API_KEY}`;
      const nearbyRes = await fetch(nearbyUrl);
      const nearbyData = await nearbyRes.json();
      if (!nearbyData.results || nearbyData.results.length === 0) return res.status(200).json({ results: [] });

      const top = nearbyData.results.slice(0, 10);
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

    // 사진 2장 URL 반환
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
