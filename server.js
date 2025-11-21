import express from "express";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000; 

// 🔥 [보안/성능 개선] Express 관련 헤더 설정
app.disable('x-powered-by'); 

app.use((req, res, next) => {
    res.setHeader('Server', 'A Generic Web Server'); 
    
    if (req.path === '/api/quiz') {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
    } else {
        res.setHeader('Cache-Control', 'public, max-age=600'); 
    }
    next();
});

// --- 설정 ---
const CACHE_SIZE = 20;       
const VALIDATION_TRY = 3;    
const DAILY_LIMIT = 1000;

// --- 기존 퀴즈풀의 유명 인물 리스트 (검색 우선순위) ---
const LEGACY_NAMES = [
  "이순신", "세종대왕", "알베르트 아인슈타인", "에이브러햄 링컨", "마하트마 간디",
  "유관순", "안중근", "김구", "윤동주", "레오나르도 다 빈치", "윤봉길", "아리스토텔레스", "갈릴레오 갈릴레이",
  "미켈란젤로 부오나로티", "빈센트 반 고흐", "파블로 피카소", "아이작 뉴턴", "찰스 다윈",
  "토머스 에디슨", "니콜라 테슬라", "스티브 잡스", "빌 게이츠", "마리 퀴리",
  "루트비히 판 베토벤", "볼프강 아마데우스 모차르트", "윌리엄 셰익스피어", "나폴레옹 보나파르트",
  "칭기즈 칸", "알렉산드로스 3세", "줄리어스 시저", "조지 워싱턴", "넬슨 만델라"
];

let QUIZ_CACHE = [];
let isCaching = false;
// 🌟 [수정] 세션 카운트 대신 요청 카운트만 유지
let callCount = 0;
// 🌟 [수정] 캐싱 작업의 Promise를 저장할 변수
let cachePromise = null; 

const WIKI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Accept': 'application/json'
};

// --- [핵심] 3회 연속 타격 검증 (이미지 안정성 체크) ---
async function checkUrlStability(url) {
  if (!url) return false;
  
  for (let i = 1; i <= VALIDATION_TRY; i++) {
    try {
      const res = await axios.head(url, { 
        headers: WIKI_HEADERS, 
        timeout: 2000 
      });
      
      const contentType = res.headers['content-type'] || '';
      if (res.status !== 200 || !contentType.includes('image')) {
        return false;
      }
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      return false; 
    }
  }
  return true;
}

// --- 공통 힌트 마스킹 함수 ---
function createMaskedHint(title, extract) {
    let hintText = extract;
    const cleanTitle = title.trim();
    const parenMatch = cleanTitle.match(/\((.*?)\)/);
    if (parenMatch) {
        const parenContent = parenMatch[1]; 
        parenContent.split(/[\s\.\,\-]+/).forEach(part => {
            if (part.length > 1) {
                const safePart = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                hintText = hintText.replace(new RegExp(safePart, 'gi'), "OOO");
            }
        });
    }
    const baseName = cleanTitle.replace(/\s*\(.*?\)\s*/g, ''); 
    const nameParts = baseName.split(' ');
    nameParts.forEach(word => {
        if (word.length >= 2) {
            hintText = hintText.replace(new RegExp(word, 'gi'), "OOO");
            if (word.length >= 3 && !/\s/.test(word)) { 
                for(let i = 0; i <= word.length - 2; i++) {
                    const chunk = word.substring(i, i + 2);
                    hintText = hintText.replace(new RegExp(chunk, 'gi'), "OOO");
                }
            }
        }
    });
    hintText = hintText.replace(/([a-zA-Z\d\.\,\:\-\s'\[\]\/\(\)ˌˈɛɔ]+)/g, (match, p1) => {
        const cleanedMatch = p1.trim();
        if (cleanedMatch.length > 1 && /[a-zA-Z]/.test(cleanedMatch)) {
            return "OOO";
        }
        return match; 
    });

    return hintText.substring(0, 120) + "...";
}


// --- 데이터 채굴 로직 ---
async function fillCache() {
  if (isCaching || QUIZ_CACHE.length >= CACHE_SIZE) return;
  isCaching = true;

  cachePromise = new Promise(async (resolve) => { 
      console.log("⛏️ 데이터 채굴 시작...");

      try {
          
          // 1. 유명 위인 시도
          if (QUIZ_CACHE.length < CACHE_SIZE) {
              process.stdout.write(`[유명인] 검색 시도... `);
              const famousCandidates = LEGACY_NAMES.sort(() => Math.random() - 0.5).slice(0, 5); 

              for (const pickName of famousCandidates) {
                  if (QUIZ_CACHE.length >= CACHE_SIZE) break;
                  const detailRes = await axios.get(`https://ko.wikipedia.org/w/api.php`, {
                      headers: WIKI_HEADERS,
                      params: { action: "query", titles: pickName, prop: "pageimages|extracts", pithumbsize: 500, exintro: true, explaintext: true, format: "json", origin: "*" }
                  });
                  const pages = detailRes.data.query?.pages;
                  if (!pages) continue;
                  const pageData = Object.values(pages)[0];
                  if (pageData.thumbnail?.source && pageData.extract && pageData.extract.length > 30) {
                      const imgUrl = pageData.thumbnail.source;
                      const isStable = await checkUrlStability(imgUrl);
                      if (isStable) {
                          console.log(`✅ [유명인] ${pickName} 통과.`);
                          const maskedHint = createMaskedHint(pageData.title, pageData.extract);
                          QUIZ_CACHE.push({ name: pageData.title, image: imgUrl, hint: maskedHint, description: pageData.extract });
                      } else {
                          console.log(`❌ [유명인] ${pickName} 이미지 검증 실패.`);
                      }
                  }
              }
          }

          // 2. 랜덤 연도 탐색 
          let randomSearchAttempts = 0;
          while (QUIZ_CACHE.length < CACHE_SIZE && randomSearchAttempts < 3) { 
              const year = Math.floor(Math.random() * (1940 - 500 + 1)) + 500; 
              process.stdout.write(`[랜덤] ${year}년도 탐색... `);
              
              const listRes = await axios.get(`https://ko.wikipedia.org/w/api.php`, {
                  headers: WIKI_HEADERS,
                  params: { action: "query", list: "categorymembers", cmtitle: `분류:${year}년_출생`, cmlimit: 50, cmtype: "page", format: "json", origin: "*" } 
              });
              
              const candidates = listRes.data.query?.categorymembers || [];

              for (const cand of candidates.slice(0, 10)) { 
                  if (QUIZ_CACHE.length >= CACHE_SIZE) break;
                  if (/\(.*\)|목록|분류|선수|배우|가수|작가|기업|작품|드라마|영화|앨범|만화/.test(cand.title)) continue; 

                  const detailRes = await axios.get(`https://ko.wikipedia.org/w/api.php`, {
                      headers: WIKI_HEADERS,
                      params: { action: "query", titles: cand.title, prop: "pageimages|extracts", pithumbsize: 500, exintro: true, explaintext: true, format: "json", origin: "*" }
                  });

                  const pages = detailRes.data.query?.pages;
                  if (!pages) continue;
                  const pageData = Object.values(pages)[0];

                  if (pageData.thumbnail?.source && pageData.extract && pageData.extract.length > 300) { 
                      const imgUrl = pageData.thumbnail.source;
                      const isStable = await checkUrlStability(imgUrl);
                      
                      if (isStable) {
                          console.log(`✅ [랜덤] ${pageData.title} 통과.`);
                          const maskedHint = createMaskedHint(pageData.title, pageData.extract);
                          QUIZ_CACHE.push({ name: pageData.title, image: imgUrl, hint: maskedHint, description: pageData.extract });
                      } else {
                          console.log(`❌ [랜덤] ${pageData.title} 이미지 검증 실패.`);
                      }
                  }
              }
              randomSearchAttempts++;
          }

      } catch (e) {
          console.error("채굴 중 오류:", e.message);
      } finally {
          isCaching = false;
          if (QUIZ_CACHE.length < 5) setTimeout(fillCache, 3000); 
          resolve();
      }
  });
  
  return cachePromise; 
}

fillCache(); 

// --- API ---
app.get("/api/quiz", async (req, res) => {
  try {
    // 🌟 [수정] 간단한 고유 요청 ID 생성
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; 
    console.log(`[Request] New request: ${requestId}`);

    // 🌟 [수정] 캐싱 작업 중이라면 완료될 때까지 대기 (503 방지)
    if (isCaching && cachePromise) {
        await cachePromise; 
    }

    if (callCount >= DAILY_LIMIT) {
      return res.status(429).json({ error: "오늘 호출 한도 초과", requestId });
    }
  
    callCount++;
  
    // 캐시가 비어있으면 다시 채우고, 채워질 때까지 다시 대기 
    if (QUIZ_CACHE.length === 0) {
        await fillCache(); 
        await cachePromise;
    }
  
    const item = QUIZ_CACHE.shift();
  
    if (!item) {
        fillCache(); 
        return res.status(503).json({ error: "데이터 준비 중입니다. 잠시만 기다려주세요.", requestId });
    }

    if (QUIZ_CACHE.length < CACHE_SIZE / 2) fillCache();

    res.json({ 
      ...item, 
      imageUrl: item.image, 
      remaining: DAILY_LIMIT - callCount, 
      // 🌟 [수정] 요청 ID를 응답에 포함
      requestId 
    });

  } catch (error) {
    console.error("API 퀴즈 처리 중 심각한 오류 발생:", error);
    const errorId = `err_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; 
    res.status(500).json({ error: "서버 내부 오류로 퀴즈를 불러올 수 없습니다.", errorId });
  }
});

// --- 정적 ---
app.use(express.static(path.join(process.cwd(), "public")));
app.get("/", (req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));