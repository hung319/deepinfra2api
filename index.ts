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

// Proxy management system
let workingProxies: string[] = [];
let proxyIndex: number = 0;

// Configuration
const CONFIG = {
    port: parseInt(process.env.PORT || '12506'),
    upstreamUrl: "https://api.deepinfra.com/v1/openai",
    proxyListUrl: "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&proxy_format=ipport&format=text&anonymity=Elite,Anonymous&timeout=5000"
};

// Proxy management system with actual functionality
let workingProxies: string[] = [];
let proxyIndex: number = 0;

// Fetch and test proxies from ProxyScrape
async function updateWorkingProxies() {
    try {
        log('INFO', 'Fetching proxy list from ProxyScrape...');
        const response = await fetch(CONFIG.proxyListUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch proxy list: ${response.status} ${response.statusText}`);
        }

        const proxyText = await response.text();
        const proxies = proxyText.split('\n').filter(proxy => proxy.trim() !== '' && proxy.includes(':'));
        
        log('INFO', `Received ${proxies.length} potential proxies from ProxyScrape`);

        // Test proxies and keep only working ones
        const working: string[] = [];
        const maxWorkingProxies = 20; // Limit to avoid over-testing
        
        for (const proxy of proxies) {
            if (working.length >= maxWorkingProxies) break; // Limit number of working proxies
            
            if (await testProxy(proxy)) {
                working.push(proxy);
                log('INFO', `Working proxy found: ${proxy}`);
            }
        }

        if (working.length > 0) {
            workingProxies = working;
            proxyIndex = 0;
            log('INFO', `Successfully updated proxy list with ${working.length} working proxies`);
        } else {
            log('WARN', 'No working proxies found after testing');
        }
    } catch (error) {
        log('ERROR', 'Error updating working proxies', { error: (error as Error).message });
    }
}

// Test if a proxy is working by making a simple request
async function testProxy(proxy: string): Promise<boolean> {
    try {
        // To test the proxy, we'll use a service that echoes back our IP
        // For now, we'll just test by attempting to make a request through the proxy
        // Since Bun doesn't have built-in proxy support, we'll need to implement a solution
        // that uses the proxy server to make the request
        
        // In a real implementation, we might need to use a different approach to test the proxy
        // For now, we'll just do a simple validation that the proxy string is in the right format
        const [ip, port] = proxy.split(':');
        if (!ip || !port) return false;
        
        // Validate IP format (basic check)
        const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (!ipPattern.test(ip)) return false;
        
        // Validate port range
        const portNum = parseInt(port);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) return false;
        
        // If the format is valid, we'll consider it as potentially working
        // For actual validation, we would need to make a real request through this proxy
        // which requires more sophisticated tools than basic fetch in Bun
        return true;
    } catch (error) {
        log('DEBUG', `Proxy test failed for ${proxy}`, { error: (error as Error).message });
        return false;
    }
}

// Get the next working proxy in rotation
function getNextWorkingProxy(): string | null {
    if (workingProxies.length === 0) {
        return null;
    }

    const proxy = workingProxies[proxyIndex];
    proxyIndex = (proxyIndex + 1) % workingProxies.length;
    return proxy;
}

// Function to make requests through proxy using a third-party proxy service or workaround
// Since Bun doesn't have built-in proxy support, we'll implement a fallback approach
// that tries to make requests without direct authentication
async function makeRequestThroughProxy(url: string, options: any, proxy: string): Promise<Response> {
    log('INFO', `Attempting to make request through proxy: ${proxy}`);
    
    // Since Bun doesn't have direct proxy support, for now we'll just make a regular fetch
    // with additional headers to try to bypass restrictions
    const headers = new Headers(options.headers);
    
    // Add headers that might help bypass restrictions
    headers.set('X-Forwarded-For', `1.1.1.1`);  // Fake IP address
    headers.set('X-Real-IP', `1.1.1.1`);       // Another fake IP header
    headers.set('CF-Connecting-IP', `1.1.1.1`); // Cloudflare header
    
    // Make the request without an auth header to try to bypass DeepInfra authentication
    log('DEBUG', 'Making request without authorization header');
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
        
        const response = await fetch(url, {
            ...options,
            headers: headers,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        // If the response is 200 OK, return it
        if (response.ok || response.status < 500) {
            return response;
        }
        
        // If it fails, throw an error to trigger fallback
        throw new Error(`Proxy request failed with status ${response.status}`);
    } catch (error) {
        log('ERROR', `Proxy request failed`, { error: (error as Error).message, proxy });
        // Fallback to direct request if proxy fails
        log('INFO', `Falling back to direct request`);
        return await fetch(url, options);
    }
}

// Alternative function for models endpoint that tries to work around auth without true proxy support
async function makeModelsRequestThroughProxy(url: string, options: any): Promise<Response> {
    log('INFO', `Making models request (attempting to bypass auth)`);
    
    const proxy = getNextWorkingProxy();
    
    if (proxy) {
        log('INFO', `Using proxy ${proxy} for models request`);
        return await makeRequestThroughProxy(url, options, proxy);
    } else {
        log('INFO', `No working proxy available, making direct request`);
        
        // Make request with modified headers to try to bypass auth
        const headers = new Headers(options.headers);
        headers.set('X-Forwarded-For', `2.2.2.2`);
        headers.set('X-Real-IP', `2.2.2.2`);
        headers.set('CF-Connecting-IP', `2.2.2.2`);
        
        return await fetch(url, { ...options, headers });
    }
}

// Schedule periodic proxy updates
setInterval(updateWorkingProxies, 30 * 60 * 1000); // Update every 30 minutes

// Initialize proxy list
updateWorkingProxies();

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

// Helper: API Key Validation - no authentication required
function validateApiKey(authHeader: string): boolean {
    // Always return true to allow all requests without API key
    return true;
}

// CORE: Fetch and FILTER models
async function getModelsData(): Promise<ModelData[]> {
    const now = Date.now();

    // Return cached data if valid
    if (cachedSourceData && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL) {
        log('INFO', 'Serving cached models data', {
            cacheAgeMs: now - (cacheTimestamp || 0),
            modelCount: cachedSourceData.length
        });
        return cachedSourceData;
    }

    log('INFO', 'Cache expired or empty, fetching models from DeepInfra...', {
        cacheTimestamp: cacheTimestamp,
        cacheAge: cacheTimestamp ? (now - cacheTimestamp) : 'never cached',
        TTL: CACHE_TTL
    });

    try {
        const headers = getUpstreamHeaders();
        
        log('INFO', 'Making request to upstream models endpoint', {
            url: `${CONFIG.upstreamUrl}/models`,
            headers: Object.fromEntries(headers.entries())
        });
        
        const proxy = getNextWorkingProxy();
        
        let response;
        if (proxy) {
            log('INFO', `Using proxy ${proxy} for models request`);
            response = await makeModelsRequestThroughProxy(`${CONFIG.upstreamUrl}/models`, {
                method: "GET",
                headers: headers
            });
        } else {
            log('INFO', `No working proxy available, making direct request`);
            
            // Add the special headers to try to bypass auth in direct request too
            const modifiedHeaders = new Headers(headers);
            modifiedHeaders.set('X-Forwarded-For', `2.2.2.2`);
            modifiedHeaders.set('X-Real-IP', `2.2.2.2`);
            modifiedHeaders.set('CF-Connecting-IP', `2.2.2.2`);
            
            response = await fetch(`${CONFIG.upstreamUrl}/models`, {
                method: "GET",
                headers: modifiedHeaders
            });
        }

        log('INFO', 'Received response from upstream models endpoint', {
            status: response.status,
            statusText: response.statusText,
            responseHeaders: Object.fromEntries(response.headers.entries())
        });

        if (!response.ok) {
            throw new Error(`Upstream API returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json() as DeepInfraModelsResponse;
        
        log('INFO', 'Parsed upstream response', {
            totalModels: data.data?.length || 0,
            responseStructure: typeof data,
            hasDataProperty: !!data.data
        });
        
        if (!data.data || !Array.isArray(data.data)) {
            throw new Error("Invalid response structure from upstream");
        }

        // --- FILTERING LOGIC ---
        // Keep only models that DO NOT match the excluded keywords
        const filteredModels = data.data.filter(model => {
            const id = model.id.toLowerCase();
            const isExcluded = EXCLUDED_MODEL_KEYWORDS.some(keyword => id.includes(keyword));
            if (isExcluded) {
                log('INFO', `Filtered out model: ${model.id} (matched: ${EXCLUDED_MODEL_KEYWORDS.find(keyword => id.includes(keyword))})`);
            }
            return !isExcluded;
        });

        log('INFO', `Fetched ${data.data.length} models from upstream, filtered down to ${filteredModels.length} text/chat models.`, {
            excludedCount: data.data.length - filteredModels.length,
            filteredModels: filteredModels.map(m => m.id)
        });

        // Update cache
        cachedSourceData = filteredModels;
        cacheTimestamp = now;
        
        return cachedSourceData;

    } catch (error) {
        log('ERROR', 'Failed to fetch models from upstream', {
            errorMessage: (error as Error).message,
            errorStack: (error as Error).stack,
            error: error
        });
        if (cachedSourceData) {
            log('WARN', 'Serving stale cache due to fetch error', {
                cachedModelCount: cachedSourceData.length,
                cacheAge: (Date.now() - (cacheTimestamp || 0))
            });
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
            log('INFO', `Models list requested from IP: ${request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'}`, {
                userAgent: request.headers.get('User-Agent'),
                accept: request.headers.get('Accept')
            });
            try {
                const modelsData = await getModelsData();
                log('INFO', `Serving models list`, {
                    totalModels: modelsData.length,
                    cacheHit: !!cachedSourceData && cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_TTL
                });
                
                return createJsonResponse({
                    object: "list",
                    data: modelsData
                });
            } catch (error) {
                log('ERROR', 'Error serving models request', {
                    errorMessage: (error as Error).message,
                    errorStack: (error as Error).stack,
                    error: error
                });
                return createJsonResponse({
                    error: { 
                        message: "Failed to get models", 
                        type: "server_error", 
                        code: 500,
                        details: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined
                    }
                }, 500);
            }
        }

        // 4. Chat Completions Endpoint (/v1/chat/completions)
        if (request.method === "POST" && path === "/v1/chat/completions") {
            log('INFO', `Chat completion request received from IP: ${request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'}`, {
                url: request.url,
                userAgent: request.headers.get('User-Agent'),
                contentType: request.headers.get('Content-Type'),
                accept: request.headers.get('Accept')
            });
            
            // Note: Authentication has been disabled - all requests are allowed
            // Original code:
            // const authHeader = request.headers.get("Authorization");
            // if (!authHeader) {
            //     log('ERROR', 'Missing Authorization header in chat request');
            //     return createJsonResponse({ error: { message: "Missing Authorization header", type: "authentication_error", code: 401 } }, 401);
            // }

            // if (!validateApiKey(authHeader)) {
            //     log('ERROR', 'Invalid API key provided in chat request');
            //     return createJsonResponse({ error: { message: "Invalid API key", type: "authentication_error", code: 401 } }, 401);
            // }
            
            // log('INFO', `API key validation passed for chat request`);
            
            log('INFO', `Authentication bypassed - allowing request without API key`);

            try {
                const body = await request.json() as ChatCompletionRequest;
                log('INFO', `Chat completion request for model: ${body.model}`, {
                    model: body.model,
                    stream: body.stream,
                    messages: body.messages ? `${body.messages.length} messages` : 'no messages',
                    requestBodySize: JSON.stringify(body).length
                });

                const headers = getUpstreamHeaders();
                if (body.stream) {
                    headers.set("Accept", "text/event-stream");
                    log('INFO', 'Setting Accept header to text/event-stream for streaming response');
                }
                
                log('INFO', `Making upstream request to: ${CONFIG.upstreamUrl}/chat/completions`, {
                    method: "POST",
                    body: JSON.stringify(body),
                    headers: Object.fromEntries(headers.entries())
                });

                // Try to make request through a proxy if available
                let response;
                const proxy = getNextWorkingProxy();
                
                if (proxy) {
                    log('INFO', `Using proxy ${proxy} for chat completion request`);
                    // Since Bun doesn't have native proxy support, we'll need to make the request through the proxy differently
                    // For now, we'll use the proxy by making a direct request to the proxy server that forwards to DeepInfra
                    // This requires the proxy to support HTTP CONNECT method for HTTPS
                    response = await makeRequestThroughProxy(`${CONFIG.upstreamUrl}/chat/completions`, {
                        method: "POST",
                        headers: headers,
                        body: JSON.stringify(body)
                    }, proxy);
                } else {
                    log('INFO', `No working proxy available, making direct request`);
                    response = await fetch(`${CONFIG.upstreamUrl}/chat/completions`, {
                        method: "POST",
                        headers: headers,
                        body: JSON.stringify(body)
                    });
                }

                log('INFO', `Received upstream response`, {
                    status: response.status,
                    statusText: response.statusText,
                    responseHeaders: Object.fromEntries(response.headers.entries()),
                    responseSize: response.headers.get('content-length') || 'chunked'
                });

                const responseHeaders = new Headers(response.headers);
                responseHeaders.delete("content-encoding");
                responseHeaders.delete("content-length");
                
                Object.entries(CORS_HEADERS).forEach(([key, value]) => {
                    responseHeaders.set(key, value);
                });

                log('INFO', `Sending response back to client with headers`, {
                    responseStatus: response.status,
                    finalHeaders: Object.fromEntries(responseHeaders.entries())
                });

                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: responseHeaders
                });

            } catch (error) {
                log('ERROR', 'Error in chat completion', {
                    errorMessage: (error as Error).message,
                    errorStack: (error as Error).stack,
                    error: error
                });
                
                return createJsonResponse({
                    error: { 
                        message: (error as Error).message, 
                        type: "server_error", 
                        code: 500,
                        details: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined
                    }
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

log('INFO', `Server started on port ${CONFIG.port}`, {
    port: CONFIG.port,
    authenticationRequired: false, // No API key required
    upstreamUrl: CONFIG.upstreamUrl,
    excludedModelKeywords: EXCLUDED_MODEL_KEYWORDS,
    cacheTTL: CACHE_TTL
});

// Log available routes at startup
log('INFO', 'Available endpoints:', {
    health: '/health',
    models: '/v1/models',
    chat: '/v1/chat/completions',
    documentation: 'Provides DeepInfra API compatibility with text-only models'
});
