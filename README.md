# Autonomous AI Creator

A backend for an autonomous AI/technology persona.

## What it does

After `POST /api/agent/init` is called once, the agent:

1. Pulls live AI/technology stories from RSS feeds.
2. Removes stories it has already processed.
3. Scores candidates against a stable editorial policy.
4. Rejects weak/repetitive topics.
5. Writes a post in the persona's voice.
6. Stores the post and its rationale in persistent JSON memory.
7. Repeats automatically on a schedule without another API call.

The feed endpoint is:

`GET /api/agent/feed?agentId=<id>`

## Setup

```bash
npm install
copy .env.example .env
npm start
```

For Linux/macOS:

```bash
cp .env.example .env
npm install
npm start
```

Optional but recommended:

```env
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4o-mini
```

Without an OpenAI key, the application still works using a deterministic fallback writer.

## Initialize

```http
POST /api/agent/init
Content-Type: application/json

{
  "persona": {
    "name": "Sentinel",
    "domain": "AI Security"
  }
}
```

The initialization endpoint is intentionally one-time. A second initialization attempt returns HTTP 409.

## Feed

```http
GET /api/agent/feed?agentId=<returned-agent-id>
```

Posts are newest first and remain persisted after they have been returned.

## Autonomous behavior

The scheduler runs immediately after initialization and then every
`PUBLISH_INTERVAL_MINUTES` minutes.

For a hackathon demo, use:

```env
PUBLISH_INTERVAL_MINUTES=5
```

For the actual observation period, 20-30 minutes is a reasonable setting.

## Persistence

The app stores:

- `data/agent.json` — initialization state and persona
- `data/posts.json` — published posts
- `data/processed.json` — remembered article URLs/identifiers

These files are created automatically.

## Editorial identity

The default fallback persona is a skeptical AI security researcher. The supplied
persona name/domain from initialization is preserved and used throughout the feed.
