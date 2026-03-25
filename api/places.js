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
      const { lat, lng, keyword, blogKw, district } = req.query;
      const midLat = parseFloat(lat), midLng = parseFloat(lng);

      const NAVER_ID = process.env.NAVER_CLIENT_ID;
      const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;

      // 거리 계산 헬퍼
      const toRad = d => d * Math.PI / 180;
      const distKm = (la1, ln1, la2, ln2) => {
        const R = 6371, dLa = toRad(la2-la1), dLn = toRad(ln2-ln1);
        const a = Math.sin(dLa/2)**2 + Math.cos(toRad(la1))*Math.cos(toRad(la2))*Math.sin(dLn/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      };

      let finalResults = [];

      // ── 1단계: 네이버 로컬 검색 (district 있으면 "성북구 소주 술집", 없으면 keyword만)
      if (NAVER_ID && NAVER_SECRET) {
        const naverQuery = district ? `${district} ${blogKw || keyword}` : (blogKw || keyword);
        const naverUrl = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(naverQuery)}&display=20&sort=random`;
        try {
          const naverRes = await fetch(naverUrl, {
            headers: {
              'X-Naver-Client-Id': NAVER_ID,
              'X-Naver-Client-Secret': NAVER_SECRET,
            },
          });
          const naverData = await naverRes.json();
          const naverItems = naverData.items || [];

          // 네이버 mapx/mapy: 정수형 * 1e-7 → WGS84 좌표
          const withCoords = naverItems.map(item => ({
            ...item,
            _lat: parseInt(item.mapy) * 1e-7,
            _lng: parseInt(item.mapx) * 1e-7,
          }));

          // 중간지점 기준 2km 이내만 통과
          const nearby = withCoords.filter(item =>
            distKm(midLat, midLng, item._lat, item._lng) <= 2.0
          );

          finalResults = nearby.length >= 3 ? nearby : withCoords.slice(0, 10);
        } catch { /* 네이버 실패 시 Google fallback으로 진행 */ }
      }

      // ── 2단계: Google Text Search로 사진/평점/place_id 보완
      const fields = 'name,rating,user_ratings_total,formatted_address,photos,price_level,opening_hours,place_id,types';
      const enriched = await Promise.all(finalResults.slice(0, 10).map(async item => {
        const placeName = item.title
          ? item.title.replace(/<[^>]+>/g, '')  // 네이버 응답 HTML 태그 제거
          : item.name;
        const placeAddr = item.roadAddress || item.address || '';

        try {
          // 식당명 + 도로명주소로 Google Text Search
          const q = placeAddr ? `${placeName} ${placeAddr}` : placeName;
          const tsUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&language=ko&key=${GKEY}`;
          const tsRes = await fetch(tsUrl);
          const tsData = await tsRes.json();
          const gResult = tsData.results?.[0];

          if (gResult) {
            // Google 결과가 실제로 근처인지 확인 (5km 이내)
            const gLat = gResult.geometry?.location?.lat;
            const gLng = gResult.geometry?.location?.lng;
            const gDist = (gLat && gLng) ? distKm(midLat, midLng, gLat, gLng) : 999;

            if (gDist <= 5.0) {
              // Google Details로 사진 포함 상세 정보
              const dr = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${gResult.place_id}&fields=${fields}&language=ko&key=${GKEY}`);
              const dd = await dr.json();
              const detail = dd.result || gResult;
              return {
                ...detail,
                // 네이버 원본 이름 우선 (검색 노이즈 방지)
                name: placeName,
                formatted_address: placeAddr || detail.formatted_address,
              };
            }
          }
        } catch { /* Google 실패 시 네이버 데이터만 사용 */ }

        // Google 매칭 실패 → 네이버 데이터만으로 구성
        return {
          name: placeName,
          formatted_address: item.roadAddress || item.address || '',
          rating: null,
          user_ratings_total: 0,
          photos: [],
          place_id: null,
        };
      }));

      // Google fallback: 네이버 결과가 없을 경우
      if (!enriched.length) {
        const textUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent((district || '') + ' ' + keyword)}&location=${lat},${lng}&radius=2000&language=ko&region=kr&key=${GKEY}`;
        const textRes = await fetch(textUrl);
        const textData = await textRes.json();
        const gResults = (textData.results || []).filter(r => {
          const rl = r.geometry?.location;
          return rl ? distKm(midLat, midLng, rl.lat, rl.lng) <= 2.0 : false;
        });
        if (!gResults.length) return res.status(200).json({ results: [] });

        const fallbackDetails = await Promise.all(gResults.slice(0, 10).map(async r => {
          try {
            const dr = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${r.place_id}&fields=${fields}&language=ko&key=${GKEY}`);
            const dd = await dr.json();
            return dd.result || r;
          } catch { return r; }
        }));
        enriched.push(...fallbackDetails);
      }

      if (!enriched.length) return res.status(200).json({ results: [] });

      // ── 3단계: 블로그 snippet 수집
      if (NAVER_ID && NAVER_SECRET) {
        await Promise.all(enriched.map(async place => {
          try {
            const q = `${place.name} ${blogKw || keyword}`;
            const blogUrl = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(q)}&display=5&sort=sim`;
            const blogRes = await fetch(blogUrl, {
              headers: {
                'X-Naver-Client-Id': NAVER_ID,
                'X-Naver-Client-Secret': NAVER_SECRET,
              },
            });
            const blogData = await blogRes.json();
            place.blog_snippets = (blogData.items || []).slice(0, 5).map(item =>
              (item.title + ' ' + item.description)
                .replace(/<[^>]+>/g, '')
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&')
                .replace(/&#\d+;/g, '')
                .slice(0, 200)
            );
          } catch {
            place.blog_snippets = [];
          }
        }));
      }

      return res.status(200).json({ results: enriched });
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
