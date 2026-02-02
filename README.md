Grok Imagine Studio — a clean UI for xAI's video + image generation/edit APIs.

## Getting Started

1) Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.
Add your API key(s) under **API keys (local)** in the UI.

## Notes

- The server routes live under `src/app/api/*` and proxy requests to xAI.
- Add keys in the UI (stored in browser `localStorage` and sent per request via `x-xai-api-key`).
- When multiple UI keys are enabled, requests use round-robin key rotation; each job polls with the same key it started with.
- Use direct, publicly accessible URLs for `image_url` and `video_url` (xAI must be able to fetch them).
- For image generation/edit, set `response_format: "b64_json"` to receive base64 output (default is hosted `url`).

## Links

- Video guide: https://docs.x.ai/docs/guides/video-generation
- Image guide: https://docs.x.ai/docs/guides/image-generation
