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
    [key: string]: any; // Allow additional properties
}

// Load configuration from environment variables
const CONFIG = {
    port: parseInt(process.env.PORT || '12506'),
    apiKey: process.env.API_KEY || 'default-key-change-me',
    corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['*'],
    upstreamUrl: "https://api.deepinfra.com/v1/openai"
};

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

// Simplified CORS headers
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
};

// Common Headers Strategy to mimic browser behavior (avoid 403s)
function getUpstreamHeaders(): Headers {
    return new Headers({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0",
        "Accept": "application/json", // Changed for general usage
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

// Helper function to create JSON response with CORS headers
function createJsonResponse<T>(data: T, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
        },
    });
}

// Helper function to validate API key
function validateApiKey(authHeader: string): boolean {
    if (!authHeader.startsWith('Bearer ')) {
        return false;
    }
    const token = authHeader.slice(7);
    return token === CONFIG.apiKey;
}

// Optimized function to fetch models from upstream
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

        // Update cache
        cachedSourceData = data.data;
        cacheTimestamp = now;
        
        log('INFO', `Successfully cached ${cachedSourceData.length} models.`);
        return cachedSourceData;

    } catch (error) {
        log('ERROR', 'Failed to fetch models from upstream', error);
        // If fetch fails but we have old cache, return it as fallback
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

        // Handle CORS preflight requests
        if (request.method === "OPTIONS") {
            return createJsonResponse(null, 204);
        }

        // Handle GET requests for models list
        if (request.method === "GET" && url.pathname === "/models") {
            // Optional: Add API Key validation for models endpoint if desired, 
            // currently public as per original code logic.
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
                    error: {
                        message: "Failed to get models",
                        type: "server_error",
                        code: 500
                    }
                }, 500);
            }
        }

        // Handle POST requests for chat completions
        if (request.method !== "POST" || url.pathname !== "/chat/completions") {
            // Allow simple root check or 404 others
            if (url.pathname === "/") return new Response("DeepInfra Proxy Active");
            
            return createJsonResponse({
                error: {
                    message: "Method not allowed",
                    type: "invalid_request_error",
                    code: 405
                }
            }, 405);
        }

        // Validate Authorization header
        const authHeader = request.headers.get("Authorization");
        if (!authHeader) {
            return createJsonResponse({
                error: {
                    message: "Missing Authorization header",
                    type: "authentication_error",
                    code: 401
                }
            }, 401);
        }

        // Validate API key
        if (!validateApiKey(authHeader)) {
            return createJsonResponse({
                error: {
                    message: "Invalid API key",
                    type: "authentication_error",
                    code: 401
                }
            }, 401);
        }

        try {
            const body = await request.json() as ChatCompletionRequest;
            log('INFO', `Chat completion request for model: ${body.model}`);

            // Use centralized headers generator, specific override for POST/Stream
            const headers = getUpstreamHeaders();
            headers.set("Accept", "text/event-stream"); // Specific for chat stream

            const response = await fetch(`${CONFIG.upstreamUrl}/chat/completions`, {
                method: "POST",
                headers: headers,
                body: JSON.stringify(body)
            });

            log('INFO', `DeepInfra response status: ${response.status}`);

            // Construct response
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: {
                    ...CORS_HEADERS,
                    "Content-Type": response.headers.get("Content-Type") || "application/json",
                }
            });

        } catch (error) {
            log('ERROR', 'Error in chat completion', error);
            return createJsonResponse({
                error: {
                    message: (error as Error).message,
                    type: "server_error",
                    code: 500
                }
            }, 500);
        }
    },
});

log('INFO', `Server started on port ${server.port}`);
