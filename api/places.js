export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { action, query, place_id, lat, lng } = req.query;

  try {
    // 1) 동네명으로 식당 목록 검색 (상세정보 포함) — 한번에 10개 가져옴
    if (action === 'search') {
      const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&language=ko&region=kr&key=${API_KEY}`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();

      if (!searchData.results || searchData.results.length === 0) {
        return res.status(200).json({ results: [] });
      }

      // 상위 10개만 상세정보 병렬 조회
      const top = searchData.results.slice(0, 10);
      const fields = 'name,rating,user_ratings_total,formatted_address,photos,price_level,opening_hours,place_id';
      const details = await Promise.all(
        top.map(async (place) => {
          try {
            const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=${fields}&language=ko&key=${API_KEY}`;
            const detailRes = await fetch(detailUrl);
            const detailData = await detailRes.json();
            return detailData.result || place;
          } catch {
            return place;
          }
        })
      );

      return res.status(200).json({ results: details });
    }

    // 2) 사진 URL 반환 (리다이렉트 따라가서 실제 이미지 URL 반환)
    if (action === 'photo') {
      const { photo_reference, maxwidth = 600 } = req.query;
      const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photo_reference=${photo_reference}&key=${API_KEY}`;
      const r = await fetch(url, { redirect: 'follow' });
      return res.status(200).json({ photo_url: r.url });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
