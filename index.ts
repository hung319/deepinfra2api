// Define interfaces based on DeepInfra response structure
interface ModelPricing {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
}

interface ModelMetadata {
    description?: string;
    context_length?: number;
    max_tokens?: number;
    pricing?: ModelPricing;
    tags?: string[];
}

interface ModelData {
    id: string;
    object: string;
    created: number;
    owned_by: string;
    root?: string;
    parent?: string | null;
    metadata?: ModelMetadata | null;
}

interface DeepInfraModelsResponse {
    object: string;
    data: ModelData[];
}

interface ChatCompletionRequest {
    model: string;
    stream?: boolean; 
    [key: string]: any; 
}

// Load configuration
const CONFIG = {
    port: parseInt(process.env.PORT || '12506'),
    apiKey: process.env.API_KEY || 'default-key-change-me',
    upstreamUrl: "https://api.deepinfra.com/v1/openai"
};

// FILTER CONFIGURATION: Keywords to exclude non-text models
// Removes: Image generators, Image editors, specialized OCR, and CLIP embeddings
const EXCLUDED_MODEL_KEYWORDS = [
    "stabilityai",       // SDXL / Stable Diffusion
    "black-forest-labs", // FLUX models
    "bria",              // Image editing tools
    "seedream",          // ByteDance Image Gen
    "image-edit",        // Qwen Image Edit
    "clip-vit",          // CLIP (Image-Text embedding)
    "ocr",               // OCR models (Image to Text)
    "janus",             // Multimodal/Image Gen
    "diffusion"          // Generic diffusion catch
];

// Simple logging function
function log(level: 'INFO' | 'ERROR' | 'WARN', message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${level}: ${message}`;
    if (data) {
        console.log(logMessage, data);
    } else {
        console.log(logMessage);
    }
}

// Cache configuration
let cachedSourceData: ModelData[] | null = null;
let cacheTimestamp: number | null = null;
const CACHE_TTL = 60 * 1000; // 1 minute cache

// Aggressive CORS Headers
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
};

// Upstream Headers Strategy
function getUpstreamHeaders(): Headers {
    return new Headers({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Content-Type": "application/json",
        "sec-ch-ua-platform": "Windows",
        "X-Deepinfra-Source": "web-page",
        "sec-ch-ua": "\"Not(A:Brand\";v=\"99\", \"Microsoft Edge\";v=\"133\", \"Chromium\";v=\"133\"",
        "sec-ch-ua-mobile": "?0",
        "Origin": "https://deepinfra.com",
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Referer": "https://deepinfra.com/"
    });
}

// Helper: JSON Response with CORS
function createJsonResponse<T>(data: T, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
        },
    });
}

// Helper: API Key Validation
function validateApiKey(authHeader: string): boolean {
    if (!authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);
    return token === CONFIG.apiKey;
}

// CORE: Fetch and FILTER models
async function getModelsData(): Promise<ModelData[]> {
    const now = Date.now();

    // Return cached data if valid
    if (cachedSourceData && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL) {
        return cachedSourceData;
    }

    log('INFO', 'Cache expired or empty, fetching models from DeepInfra...');

    try {
        const headers = getUpstreamHeaders();
        
        const response = await fetch(`${CONFIG.upstreamUrl}/models`, {
            method: "GET",
            headers: headers
        });

        if (!response.ok) {
            throw new Error(`Upstream API returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json() as DeepInfraModelsResponse;
        
        if (!data.data || !Array.isArray(data.data)) {
            throw new Error("Invalid response structure from upstream");
        }

        // --- FILTERING LOGIC ---
        // Keep only models that DO NOT match the excluded keywords
        const filteredModels = data.data.filter(model => {
            const id = model.id.toLowerCase();
            return !EXCLUDED_MODEL_KEYWORDS.some(keyword => id.includes(keyword));
        });

        log('INFO', `Fetched ${data.data.length} models, filtered down to ${filteredModels.length} text/chat models.`);

        // Update cache
        cachedSourceData = filteredModels;
        cacheTimestamp = now;
        
        return cachedSourceData;

    } catch (error) {
        log('ERROR', 'Failed to fetch models from upstream', error);
        if (cachedSourceData) {
            log('WARN', 'Serving stale cache due to fetch error');
            return cachedSourceData;
        }
        throw error;
    }
}

// Main server logic
const server = Bun.serve({
    port: CONFIG.port,
    async fetch(request: Request) {
        const url = new URL(request.url);
        const path = url.pathname;

        // 1. Global CORS Preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // 2. Health Check
        if (request.method === "GET" && path === "/health") {
            return createJsonResponse({
                status: "ok",
                service: "deepinfra-proxy-text-only",
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        }

        // 3. Models Endpoint (/v1/models)
        if (request.method === "GET" && path === "/v1/models") {
            log('INFO', `Models list requested from ${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
            try {
                const modelsData = await getModelsData();
                return createJsonResponse({
                    object: "list",
                    data: modelsData
                });
            } catch (error) {
                log('ERROR', 'Error serving models request', error);
                return createJsonResponse({
                    error: { message: "Failed to get models", type: "server_error", code: 500 }
                }, 500);
            }
        }

        // 4. Chat Completions Endpoint (/v1/chat/completions)
        if (request.method === "POST" && path === "/v1/chat/completions") {
            const authHeader = request.headers.get("Authorization");
            if (!authHeader) {
                return createJsonResponse({ error: { message: "Missing Authorization header", type: "authentication_error", code: 401 } }, 401);
            }

            if (!validateApiKey(authHeader)) {
                return createJsonResponse({ error: { message: "Invalid API key", type: "authentication_error", code: 401 } }, 401);
            }

            try {
                const body = await request.json() as ChatCompletionRequest;
                log('INFO', `Chat completion request for model: ${body.model}`);

                const headers = getUpstreamHeaders();
                if (body.stream) {
                    headers.set("Accept", "text/event-stream");
                }

                const response = await fetch(`${CONFIG.upstreamUrl}/chat/completions`, {
                    method: "POST",
                    headers: headers,
                    body: JSON.stringify(body)
                });

                log('INFO', `DeepInfra response status: ${response.status}`);

                const responseHeaders = new Headers(response.headers);
                responseHeaders.delete("content-encoding");
                responseHeaders.delete("content-length");
                
                Object.entries(CORS_HEADERS).forEach(([key, value]) => {
                    responseHeaders.set(key, value);
                });

                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: responseHeaders
                });

            } catch (error) {
                log('ERROR', 'Error in chat completion', error);
                return createJsonResponse({
                    error: { message: (error as Error).message, type: "server_error", code: 500 }
                }, 500);
            }
        }

        // 5. Fallback / Root
        if (path === "/") {
            return new Response("DeepInfra Proxy Active (Text Models Only)", {
                headers: { "Content-Type": "text/plain", ...CORS_HEADERS }
            });
        }
        
        return createJsonResponse({
            error: {
                message: `Route ${path} not found. Available: /v1/models, /v1/chat/completions`,
                type: "invalid_request_error",
                code: 404
            }
        }, 404);
    },
});

log('INFO', `Server started on port ${server.port}`);
