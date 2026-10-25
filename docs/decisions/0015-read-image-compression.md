# 0015 Override read to compress images; original: true opts out

Date: 2026-10-25

## Status

Accepted

## Context

Pi's built-in `read` resizes images only to stay under API limits: 2000px
long edge and 4.5 MB base64 (`utils/image-resize-core.js`). Every request
resends the whole conversation, images included, so a session with a few
large screenshots streams slowly on every later turn. The owner saw this lag
on real providers. Measured with real pi 1.4 against a fake provider: a
3520x2384 screenshot went out as a 1081 KB PNG, a 1254x1254 photo as 1442 KB.

## Decision

- pi-utils registers `read`, built from pi's own `createReadToolDefinition`
  (text reads, schema, renderers, structured output unchanged) plus an
  optional `original` boolean.
- pi's read runs with `autoResizeImages: false`; pi-utils then runs one
  resize pass with pi's exported `resizeImage`. One pass, because two lossy
  passes stack artifacts.
- Default caps (`read` settings): 1568px long edge (Anthropic standard-tier
  limit, models downscale anything larger) and 200 KB base64 (owner choice).
  The model's own `inputLimits.images.resize` wins when it is smaller.
- `original: true` runs the pass with pi's limits, so it sends exactly what
  pi's built-in read sends. Raw bytes are never sent: past 5 MB (Bedrock) or
  2000px with more than 20 images (Anthropic), the request would be rejected.
- A compressed result says so and tells the agent to use `original: true`
  for finer detail.
- `disabledTools: ["read"]` restores pi's built-in read.

## Alternatives Considered

1. `tool_result` hook recompressing pi's already-resized image: no way to add
   `original`, and a second lossy pass.
2. `context` hook shrinking every image in history before each request:
   covers pasted images and old sessions, but rewrites history bytes (breaks
   the prompt cache once) and adds per-turn work. Owner chose read only.

## Consequences

Positive:

- Measured live: screenshot request 1090 KB -> 121 KB, photo 1451 KB -> 143 KB.

Tradeoffs:

- Images in history from before this change, pasted images, and images from
  other tools keep their size.
- pi's `images.autoResize: false` setting no longer applies to `read`; use
  `disabledTools: ["read"]` for that.
