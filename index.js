const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CORS ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- CONFIG ---
const SELECTED_HOST = process.env.MOVIEBOX_API_HOST || "h5.aoneroom.com";
const HOST_URL = `https://${SELECTED_HOST}`;

const DEFAULT_HEADERS = {
  'X-Client-Info': '{"timezone":"Africa/Nairobi"}',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept': 'application/json',
  'User-Agent': 'okhttp/4.12.0',
  'Referer': HOST_URL,
  'Host': SELECTED_HOST,
  'Connection': 'keep-alive',
  'X-Forwarded-For': '1.1.1.1',
  'CF-Connecting-IP': '1.1.1.1',
  'X-Real-IP': '1.1.1.1'
};

const SubjectType = { ALL: 0, MOVIES: 1, TV_SERIES: 2, MUSIC: 6 };

const jar = new CookieJar();
const axiosInstance = wrapper(axios.create({
  jar,
  withCredentials: true,
  timeout: 30000
}));

let movieboxAppInfo = null;
let cookiesInitialized = false;

// Temporary store for movie names (for dynamic download filenames)
const movieTitleCache = new Map();

// --- Helper Functions ---
function processApiResponse(response) {
  if (response.data && response.data.data) return response.data.data;
  return response.data || response;
}

async function ensureCookiesAreAssigned() {
  if (cookiesInitialized) return true;
  try {
    console.log('Initializing session cookies...');
    const response = await axiosInstance.get(
      `${HOST_URL}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,
      { headers: DEFAULT_HEADERS }
    );
    movieboxAppInfo = processApiResponse(response);
    cookiesInitialized = true;
    console.log('Session cookies initialized successfully');
  } catch (error) {
    console.error('Failed to get app info:', error.message);
    throw error;
  }
  return true;
}

async function makeApiRequest(url, options = {}) {
  await ensureCookiesAreAssigned();
  const config = {
    url,
    headers: { ...DEFAULT_HEADERS, ...options.headers },
    withCredentials: true,
    ...options
  };
  try {
    return await axiosInstance(config);
  } catch (error) {
    console.error(`Request to ${url} failed:`, error.response?.status, error.response?.statusText);
    throw error;
  }
}

async function makeApiRequestWithCookies(url, options = {}) {
  await ensureCookiesAreAssigned();
  const config = {
    url,
    headers: { ...DEFAULT_HEADERS, ...options.headers },
    withCredentials: true,
    ...options
  };
  try {
    return await axiosInstance(config);
  } catch (error) {
    console.error(`Request with cookies to ${url} failed:`, error.response?.status, error.response?.statusText);
    throw error;
  }
}

// --- ROUTES ---

app.get('/', (req, res) => {
  res.send(`<h2>🎬 MovieBox API Server is Running</h2>
  <p>Endpoints: /api/search/:query, /api/info/:movieId, /api/sources/:movieId, /api/download/:url</p>`);
});

// --- Homepage ---
app.get('/api/homepage', async (req, res) => {
  try {
    const response = await makeApiRequest(`${HOST_URL}/wefeed-h5-bff/web/home`);
    res.json({ status: 'success', data: processApiResponse(response) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Failed to fetch homepage', error: err.message });
  }
});

// --- Trending ---
app.get('/api/trending', async (req, res) => {
  try {
    const response = await makeApiRequestWithCookies(`${HOST_URL}/wefeed-h5-bff/web/subject/trending`, {
      method: 'GET',
      params: { page: req.query.page || 0, perPage: req.query.perPage || 18, uid: '5591179548772780352' }
    });
    res.json({ status: 'success', data: processApiResponse(response) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Failed to fetch trending', error: err.message });
  }
});

// --- Search ---
app.get('/api/search/:query', async (req, res) => {
  try {
    const { query } = req.params;
    const payload = {
      keyword: query,
      page: req.query.page || 1,
      perPage: req.query.perPage || 24,
      subjectType: req.query.type || SubjectType.ALL
    };

    const response = await makeApiRequestWithCookies(`${HOST_URL}/wefeed-h5-bff/web/subject/search`, {
      method: 'POST',
      data: payload
    });

    const content = processApiResponse(response);
    if (content.items) {
      content.items.forEach(item => {
        item.thumbnail = item.cover?.url || item.stills?.url || null;
      });
    }

    res.json({ status: 'success', data: content });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Search failed', error: err.message });
  }
});

// --- Info ---
app.get('/api/info/:movieId', async (req, res) => {
  try {
    const { movieId } = req.params;
    const response = await makeApiRequestWithCookies(`${HOST_URL}/wefeed-h5-bff/web/subject/detail`, {
      method: 'GET',
      params: { subjectId: movieId }
    });
    const content = processApiResponse(response);

    if (content.subject?.title) {
      movieTitleCache.set(movieId, content.subject.title); // store title for later use
    }

    res.json({ status: 'success', data: content });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Failed to fetch info', error: err.message });
  }
});

// --- Sources (fix season numbering + title caching) ---
app.get('/api/sources/:movieId', async (req, res) => {
  try {
    const { movieId } = req.params;
    let season = parseInt(req.query.season) || 0;
    const episode = parseInt(req.query.episode) || 0;

    // ✅ Fix: Some APIs start season numbering from 0, so we normalize
    if (season > 0) season -= 1; // shift numbering back by 1

    console.log(`Fetching sources for ${movieId} (season=${season + 1}, episode=${episode})`);

    const infoResponse = await makeApiRequestWithCookies(`${HOST_URL}/wefeed-h5-bff/web/subject/detail`, {
      method: 'GET',
      params: { subjectId: movieId }
    });

    const movieInfo = processApiResponse(infoResponse);
    const detailPath = movieInfo?.subject?.detailPath;
    const movieTitle = movieInfo?.subject?.title || 'movie';

    // Cache title
    movieTitleCache.set(movieId, movieTitle);

    if (!detailPath) throw new Error('Missing detail path');

    const refererUrl = `https://fmoviesunblocked.net/spa/videoPlayPage/movies/${detailPath}?id=${movieId}&type=/movie/detail`;

    const response = await makeApiRequestWithCookies(`${HOST_URL}/wefeed-h5-bff/web/subject/download`, {
      method: 'GET',
      params: { subjectId: movieId, se: season, ep: episode },
      headers: { 'Referer': refererUrl, 'Origin': 'https://fmoviesunblocked.net' }
    });

    const content = processApiResponse(response);

    if (content?.downloads) {
      const sources = content.downloads.map(file => ({
        id: file.id,
        quality: file.resolution || 'Unknown',
        directUrl: file.url,
        proxyUrl: `${req.protocol}://${req.get('host')}/api/download/${encodeURIComponent(file.url)}?title=${encodeURIComponent(movieTitle)}`,
        size: file.size,
        format: 'mp4'
      }));
      content.processedSources = sources;
    }

    res.json({ status: 'success', data: content });
  } catch (err) {
    console.error('Sources error:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch sources', error: err.message });
  }
});

// --- Download Proxy (use movie title as filename) ---
app.get('/api/download/*', async (req, res) => {
  try {
    const downloadUrl = decodeURIComponent(req.url.replace('/api/download/', '').split('?')[0]);
    const movieTitle = decodeURIComponent(req.query.title || 'movie');
    const safeTitle = movieTitle.replace(/[<>:"/\\|?*]+/g, ''); // sanitize filename

    console.log(`Proxying download for ${safeTitle}.mp4`);

    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'okhttp/4.12.0',
        'Referer': 'https://fmoviesunblocked.net/',
        'Origin': 'https://fmoviesunblocked.net'
      }
    });

    res.set({
      'Content-Type': response.headers['content-type'],
      'Content-Length': response.headers['content-length'],
      'Content-Disposition': `attachment; filename="${safeTitle}.mp4"`
    });

    response.data.pipe(res);
  } catch (err) {
    console.error('Download proxy error:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to proxy download', error: err.message });
  }
});

// --- Fallback ---
app.use('*', (req, res) => {
  res.status(404).json({ status: 'error', message: 'Endpoint not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MovieBox API running on http://0.0.0.0:${PORT}`);
});

module.exports = app;
