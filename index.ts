// ==========================================
// DeepInfra Proxy - Secure Whitelist CORS
// ==========================================

interface ChatCompletionRequest {
    model: string;
    stream?: boolean;
    [key: string]: any;
}

// --- Configuration ---
const CONFIG = {
    port: parseInt(process.env.PORT || '12506'),
    apiKey: process.env.API_KEY || 'default-key-change-me',
    upstreamUrl: "https://api.deepinfra.com/v1/openai",
    // Lấy danh sách allowed origins từ biến môi trường, tách bằng dấu phẩy
    // Ví dụ: ALLOWED_ORIGINS="https://airi.moeru.ai,https://my-app.com"
    // Mặc định là "*" (cho phép tất cả) nếu không set biến này.
    allowedOrigins: process.env.ALLOWED_ORIGINS 
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) 
        : ['*'] 
};

// --- Logger ---
function log(level: string, message: string) {
    console.log(`[${new Date().toISOString()}] ${level}: ${message}`);
}

// --- Dynamic CORS Handler ---
// Hàm này sẽ quyết định xem request có được phép hay không
function getCorsHeaders(requestOrigin: string | null): Headers {
    const headers = new Headers({
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Accept, Origin, User-Agent, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, Referer",
        "Access-Control-Max-Age": "86400",
    });

    // Logic kiểm tra Whitelist
    if (!requestOrigin) {
        // Nếu không có Origin (ví dụ gọi từ curl, server-side), ta có thể cho phép hoặc chặn.
        // Để debug dễ, tạm thời cho phép. Nếu muốn strict thì xóa dòng dưới.
        headers.set("Access-Control-Allow-Origin", "*");
    } else {
        // Nếu cấu hình cho phép tất cả ('*') hoặc Origin nằm trong danh sách cho phép
        if (CONFIG.allowedOrigins.includes('*') || CONFIG.allowedOrigins.includes(requestOrigin)) {
            headers.set("Access-Control-Allow-Origin", requestOrigin);
            headers.set("Vary", "Origin"); // Báo cho Cache biết response này phụ thuộc vào Origin
        }
        // LƯU Ý: Nếu không khớp, ta KHÔNG set header Access-Control-Allow-Origin.
        // Trình duyệt sẽ tự động block request này.
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

        log("INFO", `[${request.method}] ${url.pathname} | Origin: ${origin || 'Direct/Curl'}`);

        // 1. PREFLIGHT (OPTIONS)
        if (request.method === "OPTIONS") {
            // Kiểm tra Origin ngay từ bước OPTIONS
            const corsHeaders = getCorsHeaders(origin);
            
            // Nếu không có header Allow-Origin (do không khớp whitelist), trình duyệt sẽ fail ngay tại đây
            if (!corsHeaders.has("Access-Control-Allow-Origin")) {
                return new Response(null, { status: 403 }); // Forbidden
            }

            return new Response(null, {
                status: 204,
                headers: corsHeaders
            });
        }

        // Helper response có kèm CORS động
        const jsonResponse = (data: any, status = 200) => {
            const headers = getCorsHeaders(origin);
            headers.set("Content-Type", "application/json");
            return new Response(JSON.stringify(data), { status, headers });
        };

        // 2. Health Check
        if (request.method === "GET" && (url.pathname === "/v1/health" || url.pathname === "/health")) {
            return jsonResponse({ status: "ok", secured: true });
        }

        // 3. Get Models
        if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
            try {
                const res = await fetch(`${CONFIG.upstreamUrl}/models`, {
                    headers: getUpstreamHeaders()
                });
                const data = await res.json();
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
                
                const upstreamHeaders = getUpstreamHeaders();
                if (body.stream) upstreamHeaders.set("Accept", "text/event-stream");

                const upstreamRes = await fetch(`${CONFIG.upstreamUrl}/chat/completions`, {
                    method: "POST",
                    headers: upstreamHeaders,
                    body: JSON.stringify(body)
                });

                // Xử lý Headers trả về
                const responseHeaders = new Headers(upstreamRes.headers);
                
                // Áp dụng CORS whitelist của chúng ta (ghi đè header cũ của upstream)
                const dynamicCors = getCorsHeaders(origin);
                dynamicCors.forEach((value, key) => {
                    responseHeaders.set(key, value);
                });

                responseHeaders.delete("content-encoding");
                responseHeaders.delete("content-length");

                return new Response(upstreamRes.body, {
                    status: upstreamRes.status,
                    headers: responseHeaders
                });

            } catch (error) {
                return jsonResponse({ error: "Proxy Error" }, 500);
            }
        }

        return jsonResponse({ error: "Not Found" }, 404);
    }
});

log("INFO", `Server running on port ${CONFIG.port}`);
log("INFO", `Allowed Origins: ${CONFIG.allowedOrigins.join(", ")}`);
