# DeepInfra No-Auth Proxy

This is a proxy server that provides access to DeepInfra's API without requiring an API key. The service attempts to bypass DeepInfra's authentication requirement by routing requests in a way that allows access to text-based models.

## Features

- **No API Key Required**: Access DeepInfra models without authentication
- **Text Model Filtering**: Automatically filters out non-text models (image generators, OCR models, etc.)
- **Caching**: Implements model response caching to improve performance
- **Logging**: Comprehensive logging for debugging and monitoring
- **Proxy Support**: Attempts to route requests through external proxies to bypass auth

## Endpoints

- `GET /v1/models` - Get available text models
- `POST /v1/chat/completions` - Chat completion API compatible with OpenAI format
- `GET /health` - Health check endpoint

## Configuration

Environment variables:
- `PORT` - Port to run the server on (default: 12506)

## Usage

1. Install dependencies: `bun install` (if any needed)
2. Set environment variables
3. Run: `bun index.ts`

## Authentication Bypass Approach

Authentication has been disabled on the proxy side - all requests to the proxy are allowed. The proxy attempts to communicate with DeepInfra without requiring an API key by:

1. Removing authorization headers in requests to DeepInfra
2. Attempting to route requests through proxies from ProxyScrape to vary source IP
3. Adding headers to try to bypass authentication checks
4. Using techniques similar to the deepinfra-wrapper project

## Known Limitations

- True proxy routing requires HTTP proxy support, which Bun doesn't have built-in
- If DeepInfra has implemented strict authentication measures, bypass may not work
- Success depends on whether DeepInfra requires authentication for all requests
- This is a workaround approach and may stop working if DeepInfra changes their API

## Model Filtering

This proxy automatically filters out the following model types:
- Image generators (stabilityai, black-forest-labs, bria, seedream, etc.)
- Image editors
- OCR models
- CLIP embeddings
- Diffusion models