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
              maxOutputTokens: 2000,
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
      let radiusUsed = 2.0; // 블록 밖에서 선언 — return 시 참조 가능

      // ── 1단계: 네이버 로컬 검색
      if (NAVER_ID && NAVER_SECRET) {
        // district 없으면 서울을 기본값으로 (geocoder 실패 방어)
        const regionPrefix = district || '서울';
        const naverQuery = `${regionPrefix} ${blogKw || keyword}`;
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

          // 네이버 mapx/mapy: 정수 * 1e-7 → WGS84
          const withCoords = naverItems.map(item => ({
            ...item,
            _lat: parseInt(item.mapy) * 1e-7,
            _lng: parseInt(item.mapx) * 1e-7,
          }));

          // 거리 필터: 2km → 3.5km → 5km 단계적 확장
          // 절대 우회 없음 — 5km에도 3개 미만이면 있는 것만 반환
          let nearby = [];
          for (const radius of [2.0, 3.5, 5.0]) {
            nearby = withCoords.filter(item =>
              distKm(midLat, midLng, item._lat, item._lng) <= radius
            );
            radiusUsed = radius;
            if (nearby.length >= 3) break;
          }
          finalResults = nearby; // 거리 필터 결과만 사용, 절대 우회 없음
        } catch { /* 네이버 실패 시 Google fallback으로 진행 */ }
      }

      // ── 2단계: Google Text Search로 사진/평점 보완 (식당명+주소로 정확 매칭)
      const fields = 'name,rating,user_ratings_total,formatted_address,photos,price_level,opening_hours,place_id,types';
      const enriched = await Promise.all(finalResults.slice(0, 10).map(async item => {
        const placeName = item.title
          ? item.title.replace(/<[^>]+>/g, '')
          : (item.name || '');
        const placeAddr = item.roadAddress || item.address || '';

        try {
          // 구/동 이름 추출
          const addrShort = (() => {
            const guM = placeAddr.match(/([가-힣]+[구군])/);
            const dongM = placeAddr.match(/[가-힣]+[구군]\s*([가-힣0-9]+(?:동|가|읍|면|리))\b/);
            return [guM?.[1], dongM?.[1]].filter(Boolean).join(' ');
          })();

          // 1차: 식당명 + 구/동, 2차: 주소만 (식당명이 Google DB에 없는 경우 대비)
          const queries = addrShort
            ? [`${placeName} ${addrShort}`, addrShort]
            : [placeName];

          let gResult = null;
          for (const q of queries) {
            const tsUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&language=ko&key=${GKEY}`;
            const tsRes = await fetch(tsUrl);
            const tsData = await tsRes.json();
            const candidate = tsData.results?.[0];
            if (!candidate?.place_id) continue;

            // 네이버 좌표 기준 5km 이내 검증
            const gLat = candidate.geometry?.location?.lat;
            const gLng = candidate.geometry?.location?.lng;
            const gDist = (gLat && gLng) ? distKm(item._lat, item._lng, gLat, gLng) : 999;
            if (gDist <= 5.0) { gResult = candidate; break; }
          }

          if (gResult?.place_id) {
            const dr = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${gResult.place_id}&fields=${fields}&language=ko&key=${GKEY}`);
            const dd = await dr.json();
            const detail = dd.result || gResult;
            return {
              ...detail,
              name: placeName,
              formatted_address: placeAddr || detail.formatted_address || '',
            };
          }
        } catch { /* Google 실패 시 네이버 데이터만 사용 */ }

        // Google 매칭 실패 → 네이버 데이터만으로 구성
        return {
          name: placeName,
          formatted_address: placeAddr,
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

      return res.status(200).json({ results: enriched, radiusUsed });
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
