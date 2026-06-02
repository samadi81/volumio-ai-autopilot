# AI Autopilot for Volumio

An AI-driven auto-queue plugin for Volumio 3 and 4. Learns your taste from listening history + 👍/👎 feedback, then uses an LLM (or other recommender back-end) to pick the next track and queue it from your TIDAL, Qobuz, or local library.

## Features

- **Multi-provider LLM**: Anthropic (Claude), OpenAI, Google (Gemini), Groq, DeepSeek, xAI (Grok), Mistral, OpenRouter, Perplexity, Together AI, Ollama (local), or any OpenAI-compatible endpoint
- **Per-provider API key slots** — switch providers without losing keys
- **10 prompt presets** with **51 sub-variants** (Jazz Curator → ECM / Bebop / Fusion / Free / Vocal, etc.)
- **10 taste hint presets** + freeform editing
- **Energy range** (0 quiet ↔ 10 loud) as a constraint
- **Feedback loop**: skip detection (implicit 👎) + explicit 👍/👎 buttons; feedback is injected into every recommendation prompt
- **Three trigger modes**: queue empty / keep N ahead / manual only
- **Sources**: TIDAL, Qobuz, local MPD, or "Auto (any)"
- **Fallback recommenders**: Last.fm / ListenBrainz, Spotify Recommendations API, local history heuristic

## Requirements

- Volumio 3 or 4 (armhf, arm64, amd64, i386)
- A source plugin installed/active (MyVolumio TIDAL/Qobuz, or built-in MPD for local library)
- An API key for your chosen LLM (or run Ollama locally for zero-cost)

## Installation

### Via `volumio plugin install` (over SSH)

Enable SSH in the Volumio dev UI (`http://<your-volumio>/dev`), then from your local machine:

```sh
rsync -avz --exclude node_modules ./ volumio@<your-volumio>:/home/volumio/ai_autopilot/
ssh -t volumio@<your-volumio> "cd /home/volumio/ai_autopilot && volumio plugin install"
```

Or use the included helper:

```sh
./deploy.sh volumio@<your-volumio>            # install
./deploy.sh volumio@<your-volumio> fast       # quick update after code changes
./deploy.sh volumio@<your-volumio> logs       # tail plugin logs
./deploy.sh volumio@<your-volumio> reinstall  # uninstall + install
```

After install, enable the plugin via **Plugins → Installed Plugins → AI Autopilot**.

## Configuration

Open plugin settings:

- **General** — on/off, source, trigger mode, N-ahead, cooldown, history window, verbose log
- **Recommender** — pick back-end, enter API key, pick model, prompt/sub-prompt preset, hint preset, energy range
- **Actions** — Dry run (no queue), Pick next track now, List installed sources, 👍/👎 buttons, clear feedback/history

### Quick start (5 min)

1. Install plugin, enable it.
2. Open settings → Recommender.
3. Pick provider (e.g. Anthropic) → click "Get … key →" if you need one.
4. Paste API key. Leave model as (default).
5. Pick prompt preset (e.g. Jazz Curator → ECM).
6. Click "Load selected prompt → textarea". Reload page. You'll see the prompt filled in.
7. Save settings.
8. General tab → Trigger mode = "Keep N tracks ahead", N = 3. Save.
9. Play a few tracks from Qobuz/TIDAL to seed history, then the AI will start auto-queueing.

### Feedback

- 👍 Like / 👎 Dislike buttons in the Actions section record a verdict on the currently-playing track.
- Skipping a track before ~30% completion is auto-recorded as 👎 (implicit).
- Feedback is sent to the LLM on every request so it learns in real time.

### LLM providers — getting keys

- **Anthropic (Claude)** — [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
- **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Google (Gemini)** — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- **Groq** — [console.groq.com/keys](https://console.groq.com/keys) (fast, generous free tier)
- **DeepSeek** — [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) (cheap)
- **xAI (Grok)** — [console.x.ai](https://console.x.ai/)
- **Mistral** — [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys/)
- **OpenRouter** (multi-model gateway) — [openrouter.ai/keys](https://openrouter.ai/keys)
- **Perplexity** — [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)
- **Together AI** — [api.together.xyz/settings/api-keys](https://api.together.xyz/settings/api-keys)
- **Ollama** — no key, runs locally (ollama pull <model>)

## Troubleshooting

**Nothing gets queued.**  
Enable verbose log. Check `journalctl -u volumio | grep ai_autopilot`. Common causes: LLM 400 (wrong model name → use dropdown), zero search matches (LLM picked a track not in your source's catalog), cooldown blocking rapid triggers.

**The same track keeps showing up.**  
Your history window is too short, or the LLM is being too conservative. Try the "Discovery" prompt preset or raise history_window.

**LLM returns invalid JSON.**  
Switch to a stronger model. Some small models (e.g. llama-3.2-3b) struggle with structured output.

**How do I know which source plugins are installed?**  
Click "List installed sources" under Actions. Check the log for `plugins[music_service] = [...]`.

## Architecture

```
ai_autopilot/
├─ index.js              # plugin class (lifecycle, UI config, orchestration)
├─ config.json           # defaults
├─ UIConfig.json         # WebUI form
├─ package.json
├─ install.sh / uninstall.sh / deploy.sh
├─ LICENSE               # MIT
├─ i18n/
│  ├─ strings_en.json
│  └─ strings_ko.json
├─ lib/
│  ├─ history.js         # persistent history (ring buffer)
│  ├─ feedback.js        # persistent feedback (likes/dislikes/skips)
│  ├─ presets.js         # built-in prompt + hint library
│  └─ queue-monitor.js   # polls Volumio state, fires triggers, detects skips
└─ recommenders/
   ├─ base.js
   ├─ llm.js             # all LLM providers
   ├─ lastfm.js          # track.getSimilar
   ├─ spotify.js         # /v1/recommendations
   └─ local.js           # offline heuristic
```

To add a new recommender, implement `recommend(history, feedback) -> Promise<{artist,title}|null>` and register it in `index.js` under `Recommenders`.

## Privacy

- **Listening history** and **feedback** live on your Volumio device at `/data/plugins/music_service/ai_autopilot/*.json`. They never leave your device, except when passed as text to the LLM you configured.
- **API keys** are stored locally in Volumio's config system and only sent to the provider whose endpoint you selected.
- This plugin does not call home, collect telemetry, or talk to any server other than (a) your configured LLM provider and (b) `localhost` (Volumio's own REST API) for search fallback.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome. Please run `node --check` on any `.js` you modify and verify JSON syntax. No test suite yet; manual verification via the Dry Run button is the primary sanity check.
