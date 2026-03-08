# DeepInfra No-Auth Proxy

This is a proxy server that provides access to DeepInfra's API without requiring an API key. The service bypasses DeepInfra's authentication requirement by routing requests in a way that allows access to text-based models.

## Features

- **No API Key Required**: Access DeepInfra models without authentication
- **Text Model Filtering**: Automatically filters out non-text models (image generators, OCR models, etc.)
- **Caching**: Implements model response caching to improve performance
- **Logging**: Comprehensive logging for debugging and monitoring

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

## Authentication

Authentication has been disabled - all requests to the proxy are allowed. The proxy communicates with DeepInfra without requiring an API key.

## Model Filtering

This proxy automatically filters out the following model types:
- Image generators (stabilityai, black-forest-labs, bria, seedream, etc.)
- Image editors
- OCR models
- CLIP embeddings
- Diffusion models