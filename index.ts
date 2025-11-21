// ==========================================
// DeepInfra Proxy Server (Bun) - v1 API
// ==========================================

// --- Interfaces ---
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

// --- Configuration ---
const CONFIG = {
    port: parseInt(process.env.PORT || '12506'),
    apiKey: process.env.API_KEY || 'default-key-change-me', // API Key DeepInfra của bạn
    upstreamUrl: "https://api.deepinfra.com/v1/openai"
};

// --- Utils: Logger ---
function log(level: 'INFO' | 'ERROR' | 'WARN', message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${level}: ${message}`;
    if (data) console.log(logMessage, data);
    else console.log(logMessage);
}

// --- Cache State ---
let cachedSourceData: ModelData[] | null = null;
let cacheTimestamp: number | null = null;
const CACHE_TTL = 60 * 1000; // Cache models 1 phút

// --- Utils: CORS ---
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*", // Cho phép tất cả header để tránh lỗi Client
    "Access-Control-Max-Age": "86400",
};

// --- Utils: Helpers ---
function getUpstreamHeaders(): Headers {
    return new Headers({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": "https://deepinfra.com",
        "Referer": "https://deepinfra.com/"
    });
}

function createJsonResponse<T>(data: T, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

function validateApiKey(authHeader: string | null): boolean {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    return authHeader.slice(7) === CONFIG.apiKey;
}

// --- Core Logic: Fetch Models ---
async function getModelsData(): Promise<ModelData[]> {
    const now = Date.now();
    if (cachedSourceData && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL) {
        return cachedSourceData;
    }

    log('INFO', 'Fetching models from DeepInfra...');
    try {
        const response = await fetch(`${CONFIG.upstreamUrl}/models`, {
            method: "GET",
            headers: getUpstreamHeaders()
        });

        if (!response.ok) throw new Error(`Upstream error: ${response.status}`);

        const data = await response.json() as DeepInfraModelsResponse;
        cachedSourceData = data.data;
        cacheTimestamp = now;
        
        log('INFO', `Cached ${cachedSourceData.length} models.`);
        return cachedSourceData;
    } catch (error) {
        log('ERROR', 'Fetch models failed', error);
        if (cachedSourceData) return cachedSourceData; // Fail-safe
        throw error;
    }
}

// --- Server Definition ---
const server = Bun.serve({
    port: CONFIG.port,
    hostname: "0.0.0.0", // QUAN TRỌNG: Bind mọi IP để fix lỗi kết nối từ bên ngoài/Docker
    
    async fetch(request: Request) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // 1. Handle CORS Preflight
        if (request.method === "OPTIONS") {
            return createJsonResponse(null, 204);
        }

        // 2. HEALTH CHECK ENDPOINT (Quan trọng cho Monitoring/App Check)
        // Hỗ trợ cả /health và /v1/health cho chắc chắn
        if (request.method === "GET" && (pathname === "/v1/health" || pathname === "/health")) {
            return createJsonResponse({ 
                status: "ok", 
                service: "DeepInfra Proxy", 
                version: "1.0.0" 
            });
        }

        // 3. MODELS ENDPOINT (/v1/models)
        if (request.method === "GET" && pathname === "/v1/models") {
            try {
                const models = await getModelsData();
                return createJsonResponse({ object: "list", data: models });
            } catch (error) {
                return createJsonResponse({ 
                    error: { message: "Internal Server Error", type: "server_error", code: 500 } 
                }, 500);
            }
        }

        // 4. CHAT COMPLETIONS ENDPOINT (/v1/chat/completions)
        if (request.method === "POST" && pathname === "/v1/chat/completions") {
            // Auth Check
            if (!validateApiKey(request.headers.get("Authorization"))) {
                return createJsonResponse({ 
                    error: { message: "Invalid API Key", type: "authentication_error", code: 401 } 
                }, 401);
            }

            try {
                const body = await request.json() as ChatCompletionRequest;
                log('INFO', `Chat request: ${body.model} (Stream: ${body.stream || false})`);

                const headers = getUpstreamHeaders();
                // Nếu stream = true, upstream cần header accept text/event-stream
                if (body.stream) {
                    headers.set("Accept", "text/event-stream");
                }

                const response = await fetch(`${CONFIG.upstreamUrl}/chat/completions`, {
                    method: "POST",
                    headers: headers,
                    body: JSON.stringify(body)
                });

                // Stream Pass-through logic
                return new Response(response.body, {
                    status: response.status,
                    headers: {
                        ...CORS_HEADERS,
                        "Content-Type": response.headers.get("Content-Type") || "application/json",
                    }
                });

            } catch (error) {
                log('ERROR', 'Chat completion failed', error);
                return createJsonResponse({ 
                    error: { message: (error as Error).message, type: "server_error", code: 500 } 
                }, 500);
            }
        }

        // 5. Fallback (404)
        return createJsonResponse({ 
            error: { message: "Endpoint not found. Please use /v1/...", type: "invalid_request_error", code: 404 } 
        }, 404);
    },
});

log('INFO', `Server running on http://0.0.0.0:${CONFIG.port}`);
log('INFO', `Endpoints: /v1/models, /v1/chat/completions, /v1/health`);
