require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Parser = require("rss-parser");
const cron = require("node-cron");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8000);
const INTERVAL_MINUTES = Math.max(
  1,
  Number(process.env.PUBLISH_INTERVAL_MINUTES || 30),
);
const MIN_SCORE = Number(process.env.MIN_SCORE || 65);
const MAX_POSTS_PER_CYCLE = Math.max(
  1,
  Number(process.env.MAX_POSTS_PER_CYCLE || 1),
);

const DATA_DIR = path.join(__dirname, "..", "data");
const AGENT_FILE = path.join(DATA_DIR, "agent.json");
const POSTS_FILE = path.join(DATA_DIR, "posts.json");
const PROCESSED_FILE = path.join(DATA_DIR, "processed.json");

const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "Autonomous-AI-Creator/1.0",
  },
});

const RSS_FEEDS = [
  {
    name: "TechCrunch AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
  },
  {
    name: "MIT Technology Review",
    url: "https://www.technologyreview.com/feed/",
  },
  {
    name: "Google AI Blog",
    url: "https://blog.google/technology/ai/rss/",
  },
  {
    name: "OpenAI News",
    url: "https://openai.com/news/rss.xml",
  },
];

const DEFAULT_EDITORIAL_POLICY = {
  interests: [
    "AI security",
    "agentic AI",
    "AI reliability",
    "model behavior",
    "developer tools",
    "open source AI",
    "AI infrastructure",
    "privacy",
    "AI safety",
  ],
  rejectIf: [
    "pure marketing announcement",
    "celebrity or personality news without technical substance",
    "generic AI hype",
    "duplicate coverage",
    "topic with no meaningful technical implication",
  ],
  principles: [
    "Prefer technical substance over hype.",
    "Explain why the development matters now.",
    "Separate demonstrated capability from vendor claims.",
    "Prefer primary or technically credible sources.",
    "Do not invent facts.",
  ],
};

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(AGENT_FILE)) {
    writeJson(AGENT_FILE, { initialized: false });
  }

  if (!fs.existsSync(POSTS_FILE)) {
    writeJson(POSTS_FILE, []);
  }

  if (!fs.existsSync(PROCESSED_FILE)) {
    writeJson(PROCESSED_FILE, []);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function articleId(item) {
  return crypto
    .createHash("sha256")
    .update(`${item.link || ""}|${item.title || ""}`)
    .digest("hex")
    .slice(0, 32);
}

function getAgent() {
  return readJson(AGENT_FILE, { initialized: false });
}

function getPosts() {
  return readJson(POSTS_FILE, []);
}

function getProcessed() {
  return readJson(PROCESSED_FILE, []);
}

function rememberProcessed(ids) {
  const existing = getProcessed();
  const set = new Set(existing);
  ids.forEach((id) => set.add(id));

  // Keep memory bounded while preserving recent history.
  const result = Array.from(set).slice(-5000);
  writeJson(PROCESSED_FILE, result);
}

function tokenize(text) {
  return cleanText(text)
    .toLowerCase()
    .split(/[^a-z0-9+#.-]+/)
    .filter(Boolean);
}

function scoreCandidate(item, persona) {
  const title = cleanText(item.title);
  const summary = cleanText(item.contentSnippet || item.content || "");
  const text = `${title} ${summary}`.toLowerCase();

  let score = 35;

  const positiveTerms = [
    ["agent", 15],
    ["agentic", 15],
    ["security", 18],
    ["cybersecurity", 18],
    ["privacy", 12],
    ["vulnerability", 18],
    ["attack", 12],
    ["safety", 15],
    ["benchmark", 10],
    ["model", 8],
    ["open source", 12],
    ["developer", 7],
    ["infrastructure", 8],
    ["reasoning", 10],
    ["evaluation", 12],
    ["red team", 15],
    ["prompt injection", 20],
    ["computer use", 12],
    ["robotics", 7],
  ];

  for (const [term, points] of positiveTerms) {
    if (text.includes(term)) score += points;
  }

  const negativeTerms = [
    ["funding", 10],
    ["raises", 10],
    ["celebrity", 25],
    ["rumor", 15],
    ["leak", 10],
    ["best ai", 8],
    ["top ai", 8],
    ["10 tools", 12],
    ["sponsored", 30],
  ];

  for (const [term, points] of negativeTerms) {
    if (text.includes(term)) score -= points;
  }

  if (item.isoDate) {
    const ageHours = (Date.now() - new Date(item.isoDate).getTime()) / 3600000;
    if (ageHours <= 24) score += 15;
    else if (ageHours <= 72) score += 7;
    else if (ageHours > 168) score -= 10;
  }

  const domain = String(persona.domain || "").toLowerCase();
  if (domain && text.includes(domain)) score += 15;

  // A title plus a real article body is stronger than a one-line item.
  if (summary.length >= 300) score += 8;

  return Math.max(0, Math.min(100, score));
}

function rejectReason(item, score) {
  const text = `${cleanText(item.title)} ${cleanText(
    item.contentSnippet || item.content || "",
  )}`.toLowerCase();

  if (score < MIN_SCORE) {
    return "Rejected because it did not clear the persona's editorial quality threshold.";
  }

  if (
    text.includes("funding") &&
    !/(security|model|research|benchmark|open source|infrastructure)/i.test(
      text,
    )
  ) {
    return "Rejected because the story is primarily business news without enough technical substance.";
  }

  return null;
}

async function fetchLiveTopics() {
  const results = [];

  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);

      for (const item of (parsed.items || []).slice(0, 15)) {
        if (!item.link || !item.title) continue;

        results.push({
          id: articleId(item),
          title: cleanText(item.title),
          summary: cleanText(item.contentSnippet || item.content || ""),
          link: item.link,
          publishedAt: item.isoDate || item.pubDate || null,
          sourceName: feed.name,
        });
      }
    } catch (error) {
      console.error(`RSS error [${feed.name}]: ${error.message}`);
    }
  }

  const unique = new Map();
  for (const item of results) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }

  return Array.from(unique.values());
}

function buildFallbackPost(candidate, persona) {
  const name = persona.name || "Sentinel";
  const domain = persona.domain || "AI Security";
  const title = candidate.title;
  const summary =
    candidate.summary ||
    "The source provides a new development in AI and technology.";

  const lead =
    `${title} deserves attention—not because it is another AI headline, ` +
    `but because it has a concrete implication for ${domain.toLowerCase()}.`;

  const body =
    `${summary.slice(0, 520)} ` +
    `The useful question is what changes in practice: does this improve capability, ` +
    `create a new attack surface, change developer workflows, or alter how these systems ` +
    `should be evaluated? That is the lens I use before treating a launch as meaningful.`;

  return `${lead}\n\n${body}\n\n— ${name}`;
}

async function generatePost(candidate, persona) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return buildFallbackPost(candidate, persona);
  }

  const client = new OpenAI({ apiKey });

  const system = `
You are an autonomous technology persona.

Identity:
Name: ${persona.name}
Domain: ${persona.domain}

Stable editorial policy:
${DEFAULT_EDITORIAL_POLICY.principles.map((x) => `- ${x}`).join("\n")}

Interests:
${DEFAULT_EDITORIAL_POLICY.interests.join(", ")}

Write one original feed post about the supplied source.

Requirements:
- 120-220 words.
- Consistent, analytical, technically grounded voice.
- Do not merely rewrite the source.
- Explain the practical implication.
- Distinguish facts from interpretation.
- No hashtags.
- No fabricated details.
- Do not mention that you are an AI.
- End with the persona name.
`;

  const user = `
SOURCE: ${candidate.sourceName}
TITLE: ${candidate.title}
PUBLISHED: ${candidate.publishedAt || "unknown"}
URL: ${candidate.link}

SOURCE SUMMARY:
${candidate.summary.slice(0, 2500)}
`;

  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.7,
    max_tokens: 450,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  return (
    response.choices?.[0]?.message?.content?.trim() ||
    buildFallbackPost(candidate, persona)
  );
}

async function generateRationale(candidate, score, persona) {
  const whySelected =
    `Selected with an editorial score of ${score}/100 because it aligns with ` +
    `${persona.domain || "AI and technology"} and contains a concrete technical development.`;

  const whyNow = candidate.publishedAt
    ? `It is timely because the source was published around ${new Date(
        candidate.publishedAt,
      ).toISOString()}, making it relevant to the current technology cycle.`
    : "It is timely because it appeared in the current live information scan.";

  return `${whySelected} ${whyNow} It was preferred over weaker candidates because the editorial policy favors technical substance, practical implications, and non-repetitive coverage.`;
}

async function publishOneCycle() {
  const agent = getAgent();

  if (!agent.initialized) {
    return { published: 0, reason: "Agent not initialized" };
  }

  console.log(`[agent] autonomous cycle started: ${nowIso()}`);

  const topics = await fetchLiveTopics();
  const processed = new Set(getProcessed());
  const candidates = topics
    .filter((x) => !processed.has(x.id))
    .map((x) => ({
      ...x,
      score: scoreCandidate(x, agent.persona),
    }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    console.log("[agent] no new topics found");
    return { published: 0, reason: "No new topics" };
  }

  const posts = getPosts();
  const recentTitles = posts
    .slice(0, 25)
    .map((p) => p.sourceTitle?.toLowerCase())
    .filter(Boolean);

  let published = 0;
  const rememberedIds = [];

  for (const candidate of candidates) {
    if (published >= MAX_POSTS_PER_CYCLE) break;

    const rejection = rejectReason(candidate, candidate.score);

    // Remember even rejected stories so the agent does not reconsider them
    // on every cycle.
    rememberedIds.push(candidate.id);

    if (rejection) {
      console.log(`[agent] rejected: ${candidate.title} | ${rejection}`);
      continue;
    }

    const duplicate = recentTitles.some((title) => {
      const a = tokenize(title);
      const b = tokenize(candidate.title);
      const overlap = a.filter((word) => b.includes(word)).length;
      return overlap >= Math.min(4, Math.max(2, Math.floor(b.length * 0.6)));
    });

    if (duplicate) {
      console.log(`[agent] rejected as repetitive: ${candidate.title}`);
      continue;
    }

    try {
      const text = await generatePost(candidate, agent.persona);
      const rationale = await generateRationale(
        candidate,
        candidate.score,
        agent.persona,
      );

      const post = {
        id: `p-${crypto.randomUUID()}`,
        createdAt: nowIso(),
        text,
        rationale,
        sources: [candidate.link],
        sourceTitle: candidate.title,
        sourceName: candidate.sourceName,
        editorialScore: candidate.score,
      };

      const currentPosts = getPosts();
      currentPosts.push(post);
      writeJson(POSTS_FILE, currentPosts);

      published++;
      console.log(`[agent] published: ${candidate.title}`);
    } catch (error) {
      console.error(`[agent] publishing error: ${error.message}`);
    }
  }

  rememberProcessed(rememberedIds);

  console.log(`[agent] autonomous cycle finished: ${published} published`);

  return { published, candidates: candidates.length };
}

ensureDataFiles();

let cycleRunning = false;

async function safeCycle() {
  if (cycleRunning) {
    console.log("[agent] previous cycle still running; skipping");
    return;
  }

  cycleRunning = true;
  try {
    await publishOneCycle();
  } catch (error) {
    console.error("[agent] cycle failed:", error);
  } finally {
    cycleRunning = false;
  }
}

app.post("/api/agent/init", async (req, res) => {
  try {
    const current = getAgent();

    if (current.initialized) {
      return res.status(409).json({
        error: "Agent already initialized",
        agentId: current.agentId,
      });
    }

    const supplied = req.body?.persona || {};

    if (!supplied.name || !supplied.domain) {
      return res.status(400).json({
        error: "persona.name and persona.domain are required",
      });
    }

    const agent = {
      initialized: true,
      agentId: crypto.randomUUID(),
      initializedAt: nowIso(),
      persona: {
        name: String(supplied.name).trim(),
        domain: String(supplied.domain).trim(),
        editorialPolicy: DEFAULT_EDITORIAL_POLICY,
      },
    };

    writeJson(AGENT_FILE, agent);

    // Start autonomous operation immediately. Do not wait for another request.
    setImmediate(safeCycle);

    return res.status(200).json({
      agentId: agent.agentId,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Initialization failed" });
  }
});

app.get("/api/agent/feed", (req, res) => {
  const agent = getAgent();

  if (!agent.initialized) {
    return res.status(400).json({
      error: "Agent has not been initialized",
    });
  }

  if (req.query.agentId !== agent.agentId) {
    return res.status(404).json({
      error: "Unknown agentId",
    });
  }

  const posts = getPosts()
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((post) => ({
      id: post.id,
      createdAt: post.createdAt,
      text: post.text,
      rationale: post.rationale,
      sources: post.sources,
    }));

  return res.json({ posts });
});

app.get("/health", (req, res) => {
  const agent = getAgent();

  res.json({
    status: "ok",
    initialized: agent.initialized,
    autonomous: agent.initialized,
    intervalMinutes: INTERVAL_MINUTES,
  });
});

app.listen(PORT, () => {
  console.log(`Autonomous AI Creator running on port ${PORT}`);
  console.log(`Autonomous cycle: every ${INTERVAL_MINUTES} minute(s)`);

  // This scheduler only becomes useful after initialization.
  cron.schedule(`*/${INTERVAL_MINUTES} * * * *`, () => {
    safeCycle();
  });
});
