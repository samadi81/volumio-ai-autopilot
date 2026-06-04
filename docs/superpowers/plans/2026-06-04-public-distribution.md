# MusePilot Public Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish MusePilot's current Qobuz-cache preview through GitHub, make feedback intake usable, and prepare the remaining Volumio Store submission steps without merging to `main`.

**Architecture:** GitHub is the public distribution and feedback surface until Volumio Store review is complete. The working branch remains `claude/gemini-llm-issues-2ATXy`; `main` is not merged. Store submission remains a separate MyVolumio/device-owner action after final device validation.

**Tech Stack:** GitHub repository, GitHub Releases, GitHub Issues, GitHub PRs, Volumio plugin submission workflow.

---

### Task 1: Verify Published GitHub Surfaces

**Files:**
- Read: `package.json`
- Read: `README.md`
- Read: `docs/USER_GUIDE_KO.md`

- [ ] **Step 1: Confirm branch is clean and pushed**

Run:

```sh
git status --short --branch
```

Expected: current branch is `claude/gemini-llm-issues-2ATXy` and matches `origin/claude/gemini-llm-issues-2ATXy`.

- [ ] **Step 2: Confirm pre-release exists**

Run:

```sh
gh release view v0.2.0-qobuz-cache-preview --repo samadi81/volumio-ai-autopilot
```

Expected: release is marked pre-release and targets `claude/gemini-llm-issues-2ATXy`.

### Task 2: Make Feedback Intake Work

**Files:**
- Read: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Read: `.github/ISSUE_TEMPLATE/qobuz_cache_issue.yml`
- Read: `.github/ISSUE_TEMPLATE/feature_request.yml`

- [ ] **Step 1: Ensure labels used by issue forms exist**

Run:

```sh
gh label create qobuz --repo samadi81/volumio-ai-autopilot --color 1f6feb --description "Qobuz auth, download, cache, or playback" || true
gh label create support --repo samadi81/volumio-ai-autopilot --color d4c5f9 --description "User support or setup help" || true
gh label create docs --repo samadi81/volumio-ai-autopilot --color 0075ca --description "Documentation and usage guide" || true
```

Expected: labels exist; existing-label errors are harmless.

### Task 3: Keep the Draft PR Aligned

**Files:**
- Read: `README.md`
- Read: `docs/PUBLISHING_KO.md`
- Read: `docs/FEEDBACK_AND_UPDATES.md`

- [ ] **Step 1: Update the draft PR title/body**

Run:

```sh
gh pr edit 9 --repo samadi81/volumio-ai-autopilot --title "[Draft] MusePilot Qobuz local-cache preview"
```

Expected: PR title describes MusePilot and Qobuz cache preview.

- [ ] **Step 2: Add PR labels**

Run:

```sh
gh pr edit 9 --repo samadi81/volumio-ai-autopilot --add-label qobuz --add-label docs
```

Expected: PR is tagged for Qobuz and docs.

### Task 4: Track Volumio Store Submission

**Files:**
- Read: `docs/PUBLISHING_KO.md`
- Read: `docs/FEEDBACK_AND_UPDATES.md`

- [ ] **Step 1: Create a GitHub issue for store submission**

Run:

```sh
gh issue create --repo samadi81/volumio-ai-autopilot --title "Prepare Volumio Plugin Store submission for MusePilot" --label docs --label support --body-file /tmp/musepilot-store-issue.md
```

Expected: an issue exists with the exact remaining manual submission steps.

### Task 5: Final Verification

**Files:**
- Read: `package.json`
- Read: `lib/http-api.js`
- Read: `UIConfig.json`

- [ ] **Step 1: Run tests and syntax checks**

Run:

```sh
npm test
node --check index.js
node --check lib/http-api.js
node --check lib/qobuz.js
node --check lib/track-cache.js
node --check lib/qobuz-metadata-cache.js
```

Expected: all tests and syntax checks pass.

- [ ] **Step 2: Confirm device remote renders feedback link**

Run:

```sh
curl -fsSL http://192.168.200.128:8488/ | rg "MusePilot Remote|피드백 / 버그 제보"
```

Expected: both strings are present.
