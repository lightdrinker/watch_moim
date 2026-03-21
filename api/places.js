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
    // 1) 텍스트 검색으로 식당 찾기
    if (action === 'search') {
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&language=ko&region=kr&type=restaurant&key=${API_KEY}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json(data);
    }

    // 2) 주변 식당 찾기 (좌표 기반)
    if (action === 'nearby') {
      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=1000&type=restaurant&language=ko&key=${API_KEY}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json(data);
    }

    // 3) 장소 상세정보 (사진 포함)
    if (action === 'detail') {
      const fields = 'name,rating,formatted_address,photos,opening_hours,price_level,url,website,formatted_phone_number';
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=${fields}&language=ko&key=${API_KEY}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json(data);
    }

    // 4) 사진 URL 반환
    if (action === 'photo') {
      const { photo_reference, maxwidth = 400 } = req.query;
      const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photo_reference=${photo_reference}&key=${API_KEY}`;
      const r = await fetch(url);
      // 구글은 사진을 리다이렉트로 줌 → 최종 URL 반환
      return res.status(200).json({ photo_url: r.url });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
