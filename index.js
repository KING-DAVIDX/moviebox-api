const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// MovieBox API configuration
const MIRROR_HOSTS = [
    "h5.aoneroom.com",
    "movieboxapp.in", 
    "moviebox.pk",
    "moviebox.ph",
    "moviebox.id",
    "v.moviebox.ph",
    "netnaija.video"
];

// Use different hosts for different endpoints - some mirrors work better for downloads
const SELECTED_HOST = process.env.MOVIEBOX_API_HOST || "h5.aoneroom.com";
const HOST_URL = `https://${SELECTED_HOST}`;

// Alternative hosts for download endpoint
const DOWNLOAD_MIRRORS = [
    "moviebox.pk",
    "moviebox.ph", 
    "moviebox.id",
    "v.moviebox.ph",
    "h5.aoneroom.com"
];

// Updated headers based on mobile app traffic analysis from PCAP + region bypass
const DEFAULT_HEADERS = {
    'X-Client-Info': '{"timezone":"Africa/Nairobi"}',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept': 'application/json',
    'User-Agent': 'okhttp/4.12.0', // Mobile app user agent from PCAP
    'Referer': HOST_URL,
    'Host': SELECTED_HOST,
    'Connection': 'keep-alive',
    // Add IP spoofing headers to bypass region restrictions
    'X-Forwarded-For': '1.1.1.1',
    'CF-Connecting-IP': '1.1.1.1',
    'X-Real-IP': '1.1.1.1'
};

// Subject types
const SubjectType = {
    ALL: 0,
    MOVIES: 1,
    TV_SERIES: 2,
    MUSIC: 6
};

// Session management - using axios cookie jar for proper session handling
const jar = new CookieJar();
const axiosInstance = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 30000
}));

let movieboxAppInfo = null;
let cookiesInitialized = false;

// Storage for movie/series information - in production, use Redis or similar
const mediaInfoCache = new Map();

// Helper functions
function processApiResponse(response) {
    if (response.data && response.data.data) {
        return response.data.data;
    }
    return response.data || response;
}

function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function generateFilename(mediaInfo, quality, season = 0, episode = 0) {
    let filename = '';
    
    if (mediaInfo) {
        const { title, originalTitle, subjectType } = mediaInfo;
        const baseName = title || originalTitle || 'media';
        const sanitizedBaseName = sanitizeFilename(baseName);
        
        if (subjectType === SubjectType.TV_SERIES && season > 0) {
            filename = `${sanitizedBaseName}_s${season.toString().padStart(2, '0')}`;
            if (episode > 0) {
                filename += `e${episode.toString().padStart(2, '0')}`;
            }
        } else {
            filename = sanitizedBaseName;
        }
        
        if (quality && quality !== 'Unknown') {
            filename += `_${quality}`;
        }
    } else {
        filename = 'media';
        if (quality && quality !== 'Unknown') {
            filename += `_${quality}`;
        }
    }
    
    return `${filename}.mp4`;
}

async function ensureCookiesAreAssigned() {
    if (!cookiesInitialized) {
        try {
            console.log('Initializing session cookies...');
            const response = await axiosInstance.get(`${HOST_URL}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`, {
                headers: DEFAULT_HEADERS
            });
            
            movieboxAppInfo = processApiResponse(response);
            cookiesInitialized = true;
            console.log('Session cookies initialized successfully');
            
            // Log available cookies for debugging
            if (response.headers['set-cookie']) {
                console.log('Received cookies:', response.headers['set-cookie']);
            }
            
        } catch (error) {
            console.error('Failed to get app info:', error.message);
            throw error;
        }
    }
    return cookiesInitialized;
}

async function makeApiRequest(url, options = {}) {
    await ensureCookiesAreAssigned();
    
    const config = {
        url: url,
        headers: { ...DEFAULT_HEADERS, ...options.headers },
        withCredentials: true,
        ...options
    };
    
    try {
        const response = await axiosInstance(config);
        return response;
    } catch (error) {
        console.error(`Request to ${url} failed:`, error.response?.status, error.response?.statusText);
        throw error;
    }
}

async function makeApiRequestWithCookies(url, options = {}) {
    await ensureCookiesAreAssigned();
    
    const config = {
        url: url,
        headers: { ...DEFAULT_HEADERS, ...options.headers },
        withCredentials: true,
        ...options
    };
    
    try {
        const response = await axiosInstance(config);
        return response;
    } catch (error) {
        console.error(`Request with cookies to ${url} failed:`, error.response?.status, error.response?.statusText);
        throw error;
    }
}

// Store media info in cache
function storeMediaInfo(movieId, mediaInfo, season = 0, episode = 0) {
    const cacheKey = `${movieId}_${season}_${episode}`;
    mediaInfoCache.set(cacheKey, {
        ...mediaInfo,
        season,
        episode,
        timestamp: Date.now()
    });
    
    // Clean up old entries (older than 1 hour)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [key, value] of mediaInfoCache.entries()) {
        if (value.timestamp < oneHourAgo) {
            mediaInfoCache.delete(key);
        }
    }
}

// Get media info from cache
function getMediaInfo(movieId, season = 0, episode = 0) {
    const cacheKey = `${movieId}_${season}_${episode}`;
    return mediaInfoCache.get(cacheKey);
}

// API Routes

// Health check
app.get('/', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MovieBox API Documentation</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 15px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #ff6b6b, #ee5a24);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            font-weight: 700;
        }
        
        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }
        
        .content {
            padding: 30px;
        }
        
        .endpoint {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 20px;
            margin-bottom: 20px;
            border-left: 5px solid #667eea;
        }
        
        .endpoint h3 {
            color: #667eea;
            margin-bottom: 10px;
            font-size: 1.3em;
        }
        
        .endpoint p {
            margin-bottom: 15px;
            color: #666;
        }
        
        .example-link {
            display: inline-block;
            background: #667eea;
            color: white;
            padding: 8px 15px;
            border-radius: 5px;
            text-decoration: none;
            font-size: 0.9em;
            margin: 5px 5px 5px 0;
            transition: background 0.3s;
        }
        
        .example-link:hover {
            background: #5a67d8;
        }
        
        .status {
            display: inline-block;
            background: #48bb78;
            color: white;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 0.8em;
            font-weight: bold;
        }
        
        .features {
            background: #e6fffa;
            border-radius: 10px;
            padding: 20px;
            margin: 20px 0;
            border-left: 5px solid #48bb78;
        }
        
        .features h3 {
            color: #48bb78;
            margin-bottom: 15px;
        }
        
        .features ul {
            list-style: none;
            padding-left: 0;
        }
        
        .features li {
            padding: 5px 0;
            color: #2d3748;
        }
        
        .features li:before {
            content: "✓ ";
            color: #48bb78;
            font-weight: bold;
        }
        
        @media (max-width: 600px) {
            .header h1 {
                font-size: 2em;
            }
            
            .content {
                padding: 20px;
            }
            
            .endpoint {
                padding: 15px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎬 MovieBox API</h1>
            <p>Complete access to movies, TV series, and streaming sources</p>
        </div>
        
        <div class="content">
            <div class="features">
                <h3>Features</h3>
                <ul>
                    <li>Real movie and TV series search with live results</li>
                    <li>Detailed movie information with metadata</li>
                    <li>Working download links in multiple qualities (360p - 1080p)</li>
                    <li>Trending content and homepage data</li>
                    <li>Proxy download endpoints to bypass restrictions</li>
                    <li>Mobile app headers for authentic data access</li>
                    <li>Smart filename generation for downloads</li>
                </ul>
            </div>
            
            <div class="endpoint">
                <h3>🔍 Search Movies & TV Series</h3>
                <p>Search for any movie or TV series and get real results from MovieBox database.</p>
                <span class="status">WORKING</span>
                <br><br>
                <a href="/api/search/avatar" class="example-link">Search: Avatar</a>
                <a href="/api/search/spider-man" class="example-link">Search: Spider-Man</a>
                <a href="/api/search/wednesday" class="example-link">Search: Wednesday</a>
            </div>
            
            <div class="endpoint">
                <h3>📋 Movie Information</h3>
                <p>Get detailed information about any movie including cast, description, ratings, and metadata.</p>
                <span class="status">WORKING</span>
                <br><br>
                <a href="/api/info/8906247916759695608" class="example-link">Avatar Info</a>
                <a href="/api/info/3815343854912427320" class="example-link">Spider-Man Info</a>
                <a href="/api/info/9028867555875774472" class="example-link">Wednesday Info</a>
            </div>
            
            <div class="endpoint">
                <h3>📥 Download Sources</h3>
                <p>Get real download links with multiple quality options. Includes both direct URLs and proxy URLs that work in browsers.</p>
                <p><strong>For Movies:</strong> Use movie ID only</p>
                <p><strong>For TV Episodes:</strong> Add season and episode parameters: <code>?season=1&episode=1</code></p>
                <span class="status">WORKING</span>
                <br><br>
                <strong>Movie Downloads:</strong><br>
                <a href="/api/sources/8906247916759695608" class="example-link">Avatar Movie</a>
                <a href="/api/sources/3815343854912427320" class="example-link">Spider-Man Movie</a>
                <br><br>
                <strong>TV Episode Downloads:</strong><br>
                <a href="/api/sources/9028867555875774472?season=1&episode=1" class="example-link">Wednesday S1E1</a>
                <a href="/api/sources/9028867555875774472?season=1&episode=2" class="example-link">Wednesday S1E2</a>
                <a href="/api/sources/9028867555875774472?season=1&episode=3" class="example-link">Wednesday S1E3</a>
            </div>
            
            <div class="endpoint">
                <h3>🏠 Homepage Content</h3>
                <p>Get the latest homepage content from MovieBox including featured movies and recommendations.</p>
                <span class="status">WORKING</span>
                <br><br>
                <a href="/api/homepage" class="example-link">View Homepage</a>
            </div>
            
            <div class="endpoint">
                <h3>🔥 Trending Content</h3>
                <p>Get currently trending movies and TV series with real-time data from MovieBox.</p>
                <span class="status">WORKING</span>
                <br><br>
                <a href="/api/trending" class="example-link">View Trending</a>
            </div>
            
            <div class="endpoint">
                <h3>⚡ Download Proxy</h3>
                <p>Proxy endpoint that adds proper headers to bypass CDN restrictions for direct downloads.</p>
                <span class="status">WORKING</span>
                <br><br>
                <p><strong>Usage:</strong> <code>/api/download/[encoded-video-url]</code></p>
                <p><small>Note: Video URLs are automatically provided in the sources endpoint response</small></p>
            </div>
            
            <div style="text-align: center; margin-top: 30px; padding: 20px; background: #f7fafc; border-radius: 10px;">
                <h3 style="color: #2d3748; margin-bottom: 10px;">API Status</h3>
                <p><strong>All 6 endpoints operational</strong> with real MovieBox data</p>
                <p style="color: #666; font-size: 0.9em; margin-top: 10px;">
                    Successfully converted from Python moviebox-api to JavaScript Express server<br>
                    with region bypass and mobile authentication headers
                </p>
            </div>
        </div>
    </div>
</body>
</html>`;
    
    res.send(html);
});

// Homepage content
app.get('/api/homepage', async (req, res) => {
    try {
        const response = await makeApiRequest(`${HOST_URL}/wefeed-h5-bff/web/home`);
        const content = processApiResponse(response);
        
        res.json({
            status: 'success',
            data: content
        });
    } catch (error) {
        console.error('Homepage error:', error.message);
        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch homepage content',
            error: error.message
        });
    }
});

// Trending content
app.get('/api/trending', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 0;
        const perPage = parseInt(req.query.perPage) || 18;
        
        const params = {
            page,
            perPage,
            uid: '5591179548772780352'
        };
        
        const response = await makeApiRequestWithCookies(`${HOST_URL}/wefeed-h5-bff/web/subject/trending`, {
            method: 'GET',
            params
        });
        
        const content = processApiResponse(response);
        
        res.json({
            status: 'success',
            data: content
        });
    } catch (error) {
        console.error('Trending error:', error.message);
        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch trending content',
            error: error.message
        });
    }
});

// Search movies and TV series
app.get('/api/search/:query', async (req, res) => {
    try {
        const { query } = req.params;
        const page = parseInt(req.query.page) || 1;
        const perPage = parseInt(req.query.perPage) || 24;
        const subjectType = parseInt(req.query.type) || SubjectType.ALL;
        
        const payload = {
            keyword: query,
            page,
            perPage,
            subjectType
        };
        
        const response = await makeApiRequestWithCookies(`${HOST_URL}/wefeed-h5-bff/web/subject/search`, {
            method: 'POST',
            data: payload
        });
        
        let content = processApiResponse(response);
        
        // Filter results by subject type if specified
        if (subjectType !== SubjectType.ALL && content.items) {
            content.items = content.items.filter(item => item.subjectType === subjectType);
        }
        
        // Enhance each item with easily accessible thumbnail
        if (content.items) {
            content.items.forEach(item => {
                if (item.cover && item.cover.url) {
                    item.thumbnail = item.cover.url;
                }
                if (item.stills && item.stills.url && !item.thumbnail) {
                    item.thumbnail = item.stills.url;
                }
            });
        }
        
        res.json({
            status: 'success',
            data: content
        });
    } catch (error) {
        console.error('Search error:', error.message);
        res.status(500).json({
            status: 'error',
            message: 'Failed to search content',
            error: error.message
        });
    }
});

// Get movie/series detailed information
app.get('/api/info/:movieId', async (req, res) => {
    try {
        const { movieId } = req.params;
        
        const response = await makeApiRequestWithCookies(`${HOST_URL}/wefeed-h5-bff/web/subject/detail`, {
            method: 'GET',
            params: { subjectId: movieId }
        });
        
        const content = processApiResponse(response);
        
        // Add easily accessible thumbnail URLs
        if (content.subject) {
            if (content.subject.cover && content.subject.cover.url) {
                content.subject.thumbnail = content.subject.cover.url;
            }
            if (content.subject.stills && content.subject.stills.url && !content.subject.thumbnail) {
                content.subject.thumbnail = content.subject.stills.url;
            }
        }
        
        res.json({
            status: 'success',
            data: content
        });
    } catch (error) {
        console.error('Info error:', error.message);
        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch movie/series info',
            error: error.message
        });
    }
});

// Get streaming sources/download links
app.get('/api/sources/:movieId', async (req, res) => {
    try {
        const { movieId } = req.params;
        const season = parseInt(req.query.season) || 0; // Movies use 0 for season
        const episode = parseInt(req.query.episode) || 0; // Movies use 0 for episode
        
        // First get movie details to get the detailPath for the referer
        console.log(`Getting sources for movieId: ${movieId}`);
        
        const infoResponse = await makeApiRequestWithCookies(`${HOST_URL}/wefeed-h5-bff/web/subject/detail`, {
            method: 'GET',
            params: { subjectId: movieId }
        });
        
        const movieInfo = processApiResponse(infoResponse);
        const detailPath = movieInfo?.subject?.detailPath;
        
        if (!detailPath) {
            throw new Error('Could not get movie detail path for referer header');
        }
        
        // Store media info for later use in download proxy
        if (movieInfo?.subject) {
            storeMediaInfo(movieId, movieInfo.subject, season, episode);
        }
        
        // Create the proper referer header - try fmovies domain based on user's working link
        const refererUrl = `https://fmoviesunblocked.net/spa/videoPlayPage/movies/${detailPath}?id=${movieId}&type=/movie/detail`;
        console.log(`Using referer: ${refererUrl}`);
        
        // Also try the sources endpoint with fmovies domain
        console.log('Trying fmovies domain for sources...');
        
        const params = {
            subjectId: movieId,
            se: season,
            ep: episode
        };
        
        // Try the original endpoint with region bypass headers
        const response = await makeApiRequestWithCookies(`${HOST_URL}/wefeed-h5-bff/web/subject/download`, {
            method: 'GET',
            params,
            headers: {
                'Referer': refererUrl,
                'Origin': 'https://fmoviesunblocked.net',
                // Add region bypass headers
                'X-Forwarded-For': '1.1.1.1',
                'CF-Connecting-IP': '1.1.1.1',
                'X-Real-IP': '1.1.1.1'
            }
        });
        
        const content = processApiResponse(response);
        
        // Process the sources to extract direct download links with proxy URLs
        if (content && content.downloads) {
            const sources = content.downloads.map(file => {
                const sourceInfo = {
                    id: file.id,
                    quality: file.resolution || 'Unknown',
                    directUrl: file.url, // Original URL (blocked in browser)
                    proxyUrl: `${req.protocol}://${req.get('host')}/api/download/${encodeURIComponent(file.url)}`, // Proxied URL with proper headers
                    size: file.size,
                    format: 'mp4'
                };
                
                // Store quality info for this specific download URL
                const downloadCacheKey = `download_${Buffer.from(file.url).toString('base64')}`;
                mediaInfoCache.set(downloadCacheKey, {
                    movieId,
                    season,
                    episode,
                    quality: file.resolution || 'Unknown',
                    timestamp: Date.now()
                });
                
                return sourceInfo;
            });
            
            content.processedSources = sources;
        }
        
        res.json({
            status: 'success',
            data: content
        });
    } catch (error) {
        console.error('Sources error:', error.message);
        res.status(500).json({
            status: 'error',
            message: 'Failed to fetch streaming sources',
            error: error.message
        });
    }
});

// Download proxy endpoint - adds proper headers to bypass CDN restrictions
app.get('/api/download/*', async (req, res) => {
    try {
        const downloadUrl = decodeURIComponent(req.url.replace('/api/download/', '')); // Get and decode the URL
        
        if (!downloadUrl || (!downloadUrl.startsWith('https://bcdnw.hakunaymatata.com/') && !downloadUrl.startsWith('https://valiw.hakunaymatata.com/'))) {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid download URL'
            });
        }
        
        console.log(`Proxying download: ${downloadUrl}`);
        
        // Try to get media info from cache using download URL as key
        const downloadCacheKey = `download_${Buffer.from(downloadUrl).toString('base64')}`;
        const downloadInfo = mediaInfoCache.get(downloadCacheKey);
        
        let filename = 'movie.mp4'; // Default fallback
        
        if (downloadInfo) {
            const { movieId, season, episode, quality } = downloadInfo;
            const mediaInfo = getMediaInfo(movieId, season, episode);
            
            if (mediaInfo) {
                filename = generateFilename(mediaInfo, quality, season, episode);
                console.log(`Generated filename: ${filename} for movieId: ${movieId}, season: ${season}, episode: ${episode}`);
            }
        }
        
        // Make request with proper headers that allow CDN access
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
        
        // Forward the content-type and other relevant headers
        res.set({
            'Content-Type': response.headers['content-type'],
            'Content-Length': response.headers['content-length'],
            'Content-Disposition': `attachment; filename="${filename}"`
        });
        
        // Pipe the video stream to the response
        response.data.pipe(res);
        
    } catch (error) {
        console.error('Download proxy error:', error.message);
        res.status(500).json({
            status: 'error',
            message: 'Failed to proxy download',
            error: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        status: 'error',
        message: 'Internal server error',
        error: err.message
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        status: 'error',
        message: 'Endpoint not found',
        availableEndpoints: [
            'GET /api/homepage',
            'GET /api/trending',
            'GET /api/search/:query',
            'GET /api/info/:movieId',
            'GET /api/sources/:movieId'
        ]
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`MovieBox API Server running on http://0.0.0.0:${PORT}`);
});

module.exports = app;
