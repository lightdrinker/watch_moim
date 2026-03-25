export const config = {
  api: { bodyParser: true },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, photo_references, maxwidth = 600 } = req.query;

  // ── Gemini 프록시
  if (action === 'gemini') {
    const KEY = process.env.GEMINI_API_KEY;
    if (!KEY) return res.status(500).json({ error: 'Gemini API key not configured' });

    // body가 string으로 올 경우 대비
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const prompt = body?.prompt || '';
    if (!prompt) return res.status(400).json({ error: 'No prompt' });

    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 1500,
              responseMimeType: 'application/json',
            },
          }),
        }
      );
      const d = await r.json();
      const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.status(200).json({ text });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const GKEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!GKEY) return res.status(500).json({ error: 'Google API key not configured' });

  try {
    // ── 주변 식당 검색
    if (action === 'nearby') {
      const { lat, lng, keyword, type = 'restaurant', blogKw } = req.query;

      // 1차: Nearby Search
      const nearbyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=1000&type=${type}&keyword=${encodeURIComponent(keyword)}&language=ko&region=kr&key=${GKEY}`;
      const nearbyRes = await fetch(nearbyUrl);
      const nearbyData = await nearbyRes.json();
      let results = nearbyData.results || [];

      // 결과 부족 시 2차: Text Search 보완
      if (results.length < 5) {
        const textUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(keyword)}&location=${lat},${lng}&radius=1000&language=ko&region=kr&key=${GKEY}`;
        const textRes = await fetch(textUrl);
        const textData = await textRes.json();
        const textResults = textData.results || [];
        const existingIds = new Set(results.map(r => r.place_id));
        textResults.forEach(r => { if (!existingIds.has(r.place_id)) results.push(r); });
      }

      if (!results.length) return res.status(200).json({ results: [] });

      // 상위 10개 상세 조회
      const top = results.slice(0, 10);
      const fields = 'name,rating,user_ratings_total,formatted_address,photos,price_level,opening_hours,place_id,types';
      const details = await Promise.all(top.map(async place => {
        try {
          const dr = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=${fields}&language=ko&key=${GKEY}`);
          const dd = await dr.json();
          return dd.result || place;
        } catch { return place; }
      }));

      // ── 네이버 블로그 snippet 수집
      const NAVER_ID = process.env.NAVER_CLIENT_ID;
      const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;
      const searchKw = blogKw || keyword;

      if (NAVER_ID && NAVER_SECRET) {
        await Promise.all(details.map(async place => {
          try {
            // 시+구 파싱: "대한민국 서울특별시 마포구 ..." → "서울 마포구"
            const addr = place.formatted_address || '';
            const cleaned = addr
              .replace('대한민국 ', '')
              .replace('특별시', '')
              .replace('광역시', '')
              .replace('특별자치시', '')
              .replace('특별자치도', '');
            const tokens = cleaned.trim().split(/\s+/);
            const regionPrefix = tokens.slice(0, 2).join(' ');
            const q = `${regionPrefix} ${place.name} ${searchKw}`;

            const blogUrl = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(q)}&display=5&sort=sim`;
            const blogRes = await fetch(blogUrl, {
              headers: {
                'X-Naver-Client-Id': NAVER_ID,
                'X-Naver-Client-Secret': NAVER_SECRET,
              },
            });
            const blogData = await blogRes.json();
            const items = blogData.items || [];
            place.blog_snippets = items.slice(0, 5).map(item => {
              return (item.title + ' ' + item.description)
                .replace(/<[^>]+>/g, '')
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&')
                .replace(/&#\d+;/g, '')
                .slice(0, 200);
            });
          } catch {
            place.blog_snippets = [];
          }
        }));
      }

      return res.status(200).json({ results: details });
    }

    // ── 사진 URL 반환
    if (action === 'photo') {
      const refs = (photo_references || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 2);
      const urls = await Promise.all(refs.map(async ref => {
        try {
          const r = await fetch(
            `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photo_reference=${ref}&key=${GKEY}`,
            { redirect: 'follow' }
          );
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
