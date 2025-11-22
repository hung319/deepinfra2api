// ==========================================
// DeepInfra Proxy - Text Models Only (Cleaned)
// ==========================================

interface ChatCompletionRequest {
    model: string;
    stream?: boolean;
    messages?: any[];
    [key: string]: any;
}

// --- Configuration ---
const CONFIG = {
    port: parseInt(process.env.PORT || '12506'),
    apiKey: process.env.API_KEY || 'default-key-change-me',
    upstreamUrl: "https://api.deepinfra.com/v1/openai",
    allowedOrigins: process.env.ALLOWED_ORIGINS 
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) 
        : ['*'] 
};

// --- Filter Config: Các từ khóa cần loại bỏ ---
// Những model chứa từ này trong ID sẽ bị ẩn khỏi danh sách
const MODEL_BLACKLIST = [
    "flux",             // Tạo ảnh
    "sdxl",             // Tạo ảnh
    "stable-diffusion", // Tạo ảnh
    "bria",             // Xử lý ảnh (remove bg)
    "clip",             // Embedding/Vision
    "embedding",        // Vector Embedding (không chat được)
    "text2vec",         // Embedding
    "bert",             // Embedding
    "gte-",             // Embedding
    "e5-",              // Embedding
    "fibo",             // Image tools
    "remove_background",
    "erase_foreground",
    "gen_fill",
    "tts",              // Audio
    "whisper"           // Audio
];

// --- Logger ---
function log(level: string, message: string) {
    console.log(`[${new Date().toISOString()}] ${level}: ${message}`);
}

// --- Dynamic CORS Handler ---
function getCorsHeaders(requestOrigin: string | null): Headers {
    const headers = new Headers({
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Accept, Origin, User-Agent, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, Referer",
        "Access-Control-Max-Age": "86400",
    });

    if (!requestOrigin) {
        headers.set("Access-Control-Allow-Origin", "*");
    } else {
        if (CONFIG.allowedOrigins.includes('*') || CONFIG.allowedOrigins.includes(requestOrigin)) {
            headers.set("Access-Control-Allow-Origin", requestOrigin);
            headers.set("Vary", "Origin");
        }
    }
    return headers;
}

// --- Upstream Headers ---
function getUpstreamHeaders(originalHeaders?: Headers): Headers {
    const headers = new Headers({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": "https://deepinfra.com",
        "Referer": "https://deepinfra.com/"
    });

    if (originalHeaders?.get("Accept") === "text/event-stream") {
        headers.set("Accept", "text/event-stream");
    }
    
    return headers;
}

// --- Main Server ---
const server = Bun.serve({
    port: CONFIG.port,
    hostname: "0.0.0.0",
    
    async fetch(request: Request) {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin");

        log("INFO", `[${request.method}] ${url.pathname} | Origin: ${origin || 'Direct'}`);

        // 1. PREFLIGHT (OPTIONS)
        if (request.method === "OPTIONS") {
            const corsHeaders = getCorsHeaders(origin);
            if (!corsHeaders.has("Access-Control-Allow-Origin")) {
                return new Response(null, { status: 403 });
            }
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Helper response
        const jsonResponse = (data: any, status = 200) => {
            const headers = getCorsHeaders(origin);
            headers.set("Content-Type", "application/json");
            return new Response(JSON.stringify(data), { status, headers });
        };

        // 2. Health Check
        if (request.method === "GET" && (url.pathname === "/v1/health" || url.pathname === "/health")) {
            return jsonResponse({ status: "ok", type: "text-models-only" });
        }

        // 3. Get Models (CÓ LỌC MODEL)
        if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
            try {
                const res = await fetch(`${CONFIG.upstreamUrl}/models`, {
                    headers: getUpstreamHeaders()
                });
                
                if (!res.ok) throw new Error("Upstream failed");
                
                const data = await res.json() as { object: string, data: any[] };
                
                // --- LOGIC LỌC MODEL ---
                if (data.data && Array.isArray(data.data)) {
                    const originalCount = data.data.length;
                    
                    // Chỉ giữ lại model KHÔNG chứa từ khóa trong Blacklist
                    data.data = data.data.filter(model => {
                        const modelId = model.id.toLowerCase();
                        // Kiểm tra xem ID có chứa từ khóa cấm nào không
                        const isBlacklisted = MODEL_BLACKLIST.some(keyword => modelId.includes(keyword));
                        return !isBlacklisted;
                    });

                    log("INFO", `Filtered models: ${originalCount} -> ${data.data.length}`);
                }
                // -----------------------

                return jsonResponse(data);
            } catch (e) {
                return jsonResponse({ error: "Fetch error" }, 500);
            }
        }

        // 4. Chat Completions
        if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
            const auth = request.headers.get("Authorization");
            if (!auth || !auth.startsWith("Bearer ")) {
                return jsonResponse({ error: { message: "Invalid API Key", type: "auth_error" } }, 401);
            }

            try {
                const body = await request.json() as ChatCompletionRequest;
                
                // Giữ lại logic Mocking phòng trường hợp Client cache model cũ
                if (body.model && MODEL_BLACKLIST.some(kw => body.model.toLowerCase().includes(kw))) {
                     log("WARN", `Blocked/Mocked request for non-text model: ${body.model}`);
                     return jsonResponse({
                        id: "chatcmpl-mock-blocked",
                        object: "chat.completion",
                        created: Date.now(),
                        model: body.model,
                        choices: [{
                            index: 0,
                            message: { role: "assistant", content: "[System] This model is not available for text chat." },
                            finish_reason: "stop"
                        }]
                    });
                }

                const upstreamHeaders = getUpstreamHeaders();
                if (body.stream) upstreamHeaders.set("Accept", "text/event-stream");

                const upstreamRes = await fetch(`${CONFIG.upstreamUrl}/chat/completions`, {
                    method: "POST",
                    headers: upstreamHeaders,
                    body: JSON.stringify(body)
                });

                // Xử lý Headers trả về
                const responseHeaders = new Headers(upstreamRes.headers);
                const dynamicCors = getCorsHeaders(origin);
                dynamicCors.forEach((value, key) => responseHeaders.set(key, value));
                responseHeaders.delete("content-encoding");
                responseHeaders.delete("content-length");

                return new Response(upstreamRes.body, {
                    status: upstreamRes.status,
                    headers: responseHeaders
                });

            } catch (error) {
                return jsonResponse({ error: "Internal Proxy Error" }, 500);
            }
        }

        return jsonResponse({ error: "Not Found" }, 404);
    }
});

log("INFO", `Proxy running on port ${CONFIG.port}`);
log("INFO", `Filtering enabled for keywords: ${MODEL_BLACKLIST.join(", ")}`);
