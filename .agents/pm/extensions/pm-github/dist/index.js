// pm-github — GitHub Issues + Projects v2 sync for pm-cli
//
// Capabilities (see manifest.json):
//   commands   — `pm gh-issues import` (legacy) + `pm github sync` +
//                `pm github project list|fields|import|sync` (Projects v2)
//   importers  — `pm github import <owner/repo>` (idempotent native import)
//   exporters  — `pm github export` (render pm items as a GitHub-issues payload)
//   schema     — declares github_url / github_number / github_state /
//                github_author / github_created_at / github_updated_at item fields
//   hooks      — afterCommand: actionable sync hint for github-linked items
//   preflight  — local guard for mutating github commands (token presence)
//
// Issues use the REST API; Projects v2 is GraphQL-only (see the Projects v2
// section below and the pure plan/mapping logic in ./projects.ts).
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { comments as pmCommentsFn, commitItemMutations as sdkCommitItemMutations, listAllItemMetadata as sdkListAllItemMetadata, normalizeItemId as sdkNormalizeItemId, readSettings as sdkReadSettings, } from "@unbrained/pm-cli/sdk";
import { collectNewOrderingCycleWarnings as sdkCollectNewOrderingCycleWarnings } from "@unbrained/pm-cli/sdk/graph";
import { buildProjectImportPlan, buildProjectPullPlan, buildProjectPushPlan, parseProjectItemTag, parseProjectRef, parseStatusMap, projectItemTag, } from "./projects.js";
const COMMENTS_MODES = ["body", "annotations", "both"];
// Resolve a GitHub token so the importer is not stuck on the 60 req/hr
// unauthenticated quota and can read private repos. Order: explicit env vars,
// then the locally authenticated `gh` CLI if present.
export function resolveGitHubToken() {
    const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (envToken && envToken.trim())
        return envToken.trim();
    try {
        const result = spawnSync("gh", ["auth", "token"], { encoding: "utf-8" });
        if (result.status === 0) {
            const token = result.stdout.trim();
            if (token)
                return token;
        }
    }
    catch {
        // gh not installed — fall back to unauthenticated requests.
    }
    return undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Decide whether the Authorization token may be forwarded across a redirect.
 *
 * Only same-origin (scheme + host + port) redirects keep the credential; any
 * origin change drops it so the bearer token can never leak to a third party.
 *
 * @param fromUrl - The URL the redirect originated from.
 * @param toUrl - The redirect target URL.
 * @returns True when both URLs share an origin.
 */
export function sameOrigin(fromUrl, toUrl) {
    try {
        return new URL(fromUrl).origin.toLowerCase() === new URL(toUrl).origin.toLowerCase();
    }
    catch {
        return false;
    }
}
// Resolve the GitHub REST/GraphQL API origin. Production always targets
// `https://api.github.com`, but the whole HTTP stack must be exercisable against
// a local server for the failure-surface tests (retry, backoff, pagination,
// redirect token handling, mid-batch errors). Reading the override at CALL time
// (not module-eval time) means a test can flip `PM_GITHUB_API_BASE` per-case
// without import-order coupling, and production is unchanged when it is unset.
//
// SECURITY: every request built from this base carries the resolved GITHUB_TOKEN,
// so an unvalidated override is a token-exfiltration and TLS-downgrade primitive:
// anything able to set an env var for this process could point authenticated
// traffic at an attacker host over plain HTTP. The same-origin redirect guard
// below does NOT mitigate that, because the base *is* the origin — the very first
// request already carries the bearer token. The override is therefore constrained
// to what the tests actually need:
//   - `https:` anywhere (no credential exposure on the wire), or
//   - `http:` ONLY for loopback, which cannot leave the machine.
// Anything else throws rather than being silently ignored, so a misconfiguration
// is loud instead of quietly redirecting traffic.
/**
 * Resolve the GitHub API origin, honouring a constrained test-only override.
 *
 * @internal Exported only so the HTTP-boundary tests can drive the real client.
 * `stripInternal` keeps it out of the published `.d.ts`, so this is NOT a public API
 * commitment and must not be relied on from outside this package.
 */
export function githubApiBase() {
    const raw = process.env.PM_GITHUB_API_BASE?.trim();
    if (!raw)
        return "https://api.github.com";
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new Error(`PM_GITHUB_API_BASE is not a valid absolute URL: ${raw}`);
    }
    const isLoopback = parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1" ||
        parsed.hostname === "[::1]" ||
        parsed.hostname === "localhost";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
        throw new Error(`PM_GITHUB_API_BASE must be https, or http on loopback for a local test server; got ${raw}. ` +
            "Requests carry the GitHub token, so a plaintext non-loopback base would leak it.");
    }
    // Strip a trailing slash so `${base}/repos/...` cannot produce `//repos/...`.
    return raw.replace(/\/+$/, "");
}
/**
 * One low-level HTTP request, with no retry or backoff.
 *
 * That orchestration lives in the surrounding {@link request} wrapper. This
 * function follows up to `redirectsLeft` redirects, rejecting on a cycle or an
 * over-long chain rather than overflowing the stack, and forwards the bearer
 * token only to same-origin targets via {@link sameOrigin}.
 */
function requestOnce(method, url, token, payload, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const headers = {
            "User-Agent": "pm-github",
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        };
        if (token)
            headers.Authorization = `Bearer ${token}`;
        if (payload) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = String(Buffer.byteLength(payload));
        }
        // Dispatch on the URL scheme: production URLs are `https://` (GitHub), but
        // a `PM_GITHUB_API_BASE` override pointing at a local `http://` test server
        // must reach it over plain HTTP so the real request/response code runs.
        const target = new URL(url);
        const transport = target.protocol === "http:" ? http : https;
        const req = transport.request(target, { method, headers }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                // Drain the redirect response so the socket is returned to the pool.
                res.resume();
                if (redirectsLeft <= 0) {
                    reject(new Error(`too many redirects following ${url}`));
                    return;
                }
                // Resolve the (possibly relative) Location against the current URL, and
                // only carry the token forward on a same-origin redirect. Named
                // distinctly from the outer `target` URL: shadowing it here worked only
                // because nothing read the outer binding first, so a later edit
                // referencing the parsed URL would hit a TDZ ReferenceError at runtime
                // rather than a type error at build time.
                let redirectUrl;
                try {
                    redirectUrl = new URL(res.headers.location, url).toString();
                }
                catch {
                    reject(new Error(`invalid redirect Location from ${url}`));
                    return;
                }
                const forwardToken = sameOrigin(url, redirectUrl) ? token : undefined;
                requestOnce(method, redirectUrl, forwardToken, payload, redirectsLeft - 1).then(resolve, reject);
                return;
            }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                resolve({
                    status,
                    body: Buffer.concat(chunks).toString("utf-8"),
                    headers: res.headers,
                    linkHeader: typeof res.headers.link === "string" ? res.headers.link : undefined,
                });
            });
        });
        req.on("error", reject);
        req.setTimeout(30000, () => {
            req.destroy(new Error("request timed out after 30s"));
        });
        if (payload)
            req.write(payload);
        req.end();
    });
}
/**
 * Compute how long (ms) to wait before retrying a rate-limited or transient
 * response.
 *
 * Honors `Retry-After` (seconds) and the primary rate-limit reset window
 * (`X-RateLimit-Remaining: 0` + `X-RateLimit-Reset` epoch), then falls back to
 * exponential backoff. The result is capped so a CLI run is never hung
 * indefinitely.
 *
 * @param headers - Response headers to read the retry hints from.
 * @param attempt - Zero-based retry index feeding the exponential backoff floor.
 * @param nowMs - Current epoch ms, used to measure the reset window's remaining time.
 * @returns The capped wait in milliseconds.
 */
export function computeBackoffMs(headers, attempt, nowMs = Date.now()) {
    const get = (k) => {
        const v = headers[k] ?? headers[k.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
    };
    const cap = 60_000;
    const retryAfter = get("retry-after");
    if (retryAfter) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs) && secs >= 0)
            return Math.min(secs * 1000, cap);
    }
    const remaining = get("x-ratelimit-remaining");
    const reset = get("x-ratelimit-reset");
    if (remaining === "0" && reset) {
        const resetMs = Number(reset) * 1000;
        if (Number.isFinite(resetMs)) {
            const wait = resetMs - nowMs;
            if (wait > 0)
                return Math.min(wait + 1000, cap);
        }
    }
    // Exponential backoff: 1s, 2s, 4s … capped.
    return Math.min(1000 * 2 ** attempt, cap);
}
// Read GitHub's x-ratelimit-* headers into a structured snapshot, reporting a
// low-remaining warning once the budget drops below `lowThreshold`.
export function parseRateLimit(headers, lowThreshold = 10) {
    // Node lowercases response header names, but be defensive: scan
    // case-insensitively so a mixed-case key (e.g. from a different runtime or a
    // mocked response) is still found.
    const lower = {};
    for (const [hk, hv] of Object.entries(headers))
        lower[hk.toLowerCase()] = hv;
    const get = (k) => {
        const v = lower[k.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
    };
    const num = (s) => {
        if (s === undefined)
            return undefined;
        const n = Number(s);
        return Number.isFinite(n) ? n : undefined;
    };
    const remaining = num(get("x-ratelimit-remaining"));
    const limit = num(get("x-ratelimit-limit"));
    const reset = num(get("x-ratelimit-reset"));
    return {
        remaining,
        limit,
        reset,
        low: remaining !== undefined && remaining <= lowThreshold,
    };
}
// Human-readable one-liner for a rate-limit snapshot, e.g.
// "GitHub API quota: 4998/5000 remaining (resets 2026-06-04T01:00:00.000Z)".
// Returns undefined when no quota headers were present.
export function formatRateLimit(info) {
    if (info.remaining === undefined)
        return undefined;
    const limitPart = info.limit !== undefined ? `/${info.limit}` : "";
    let resetPart = "";
    if (info.reset !== undefined) {
        try {
            resetPart = ` (resets ${new Date(info.reset * 1000).toISOString()})`;
        }
        catch {
            resetPart = "";
        }
    }
    return `GitHub API quota: ${info.remaining}${limitPart} remaining${resetPart}`;
}
// Decide whether a failed HTTP response is worth retrying: 429, any 5xx, or a
// 403 that is actually a primary/secondary rate-limit wall (remaining=0).
function isRetryableStatus(status, headers) {
    if (status === 429)
        return true;
    if (status >= 500)
        return true;
    // Secondary/primary rate limit surfaces as 403 with remaining=0.
    if (status === 403) {
        const v = headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];
        const remaining = Array.isArray(v) ? v[0] : v;
        if (remaining === "0")
            return true;
        if (headers["retry-after"] ?? headers["Retry-After"])
            return true;
    }
    return false;
}
// Request with rate-limit/backoff handling. Retries on 429/5xx and GitHub
// rate-limit 403s, honoring Retry-After / X-RateLimit-Reset. Throws on a
// non-retryable error status so callers can map it to a semantic exit code.
async function request(method, url, token, payload, maxRetries = 4) {
    let attempt = 0;
    for (;;) {
        const res = await requestOnce(method, url, token, payload);
        if (res.status >= 200 && res.status < 300)
            return res;
        if (attempt < maxRetries && isRetryableStatus(res.status, res.headers)) {
            const wait = computeBackoffMs(res.headers, attempt);
            console.error(`GitHub returned HTTP ${res.status}; retrying in ${Math.round(wait / 1000)}s ` +
                `(attempt ${attempt + 1}/${maxRetries})…`);
            await sleep(wait);
            attempt++;
            continue;
        }
        throw new Error(`GitHub API returned HTTP ${res.status}`);
    }
}
/** Fetch a single GitHub REST endpoint via GET and return the decoded
 * {@link FetchResult}. Runs the full retry/backoff/redirect stack (`request` →
 * `requestOnce`), so it is the public entry point the failure-surface tests use
 * to exercise that stack against a local server.  *
 * @internal Exported only so the HTTP-boundary tests can drive the real client.
 * `stripInternal` keeps it out of the published `.d.ts`, so this is NOT a public API
 * commitment and must not be relied on from outside this package.
*/
export function fetchJSON(url, token) {
    return request("GET", url, token);
}
// Follow GitHub's RFC 5988 Link header so repos with more than one page of
// issues are fully imported instead of silently truncated at per_page.
export function parseNextLink(linkHeader) {
    if (!linkHeader)
        return undefined;
    for (const part of linkHeader.split(",")) {
        const match = part.match(/^\s*<([^>]{1,2048})>\s*;\s*rel="next"/);
        if (match)
            return match[1];
    }
    return undefined;
}
// Map a GitHub issue/PR state (+ optional stateReason) onto a pm status,
// preserving `not_planned` closures as `canceled` rather than `closed`.
export function mapState(state, stateReason) {
    if (state === "closed" && stateReason === "not_planned")
        return "canceled";
    return state === "closed" ? "closed" : "open";
}
// Flags may arrive under their kebab-case (`dry-run`) or camelCase (`dryRun`)
// key depending on runtime normalization, so check every candidate.
export function optionEnabled(options, ...keys) {
    return keys.some((k) => {
        const v = options[k];
        return v === true || v === "true" || v === "1";
    });
}
// Read the first non-empty trimmed string option under any of the given
// (kebab- or camel-case) keys; returns undefined when none are set.
export function optionString(options, ...keys) {
    for (const k of keys) {
        const v = options[k];
        if (typeof v === "string" && v.trim().length > 0)
            return v.trim();
    }
    return undefined;
}
// Whether an option key was explicitly provided (even if empty/falsey).
export function optionProvided(options, ...keys) {
    return keys.some((k) => Object.prototype.hasOwnProperty.call(options, k));
}
// Parse a `--since` value into an ISO timestamp the GitHub `since` query param
// accepts. Accepts either an ISO 8601 timestamp (passed through, invalid date
// returns undefined) or a relative duration like `7d` / `12h` / `1w` / `30m`,
// resolved against `now`. This enables incremental imports without the caller
// having to compute an absolute timestamp first.
export function parseSince(value, nowMs = Date.now()) {
    if (!value || !value.trim())
        return undefined;
    const v = value.trim();
    const rel = /^(\d+)\s*(m|h|d|w)$/i.exec(v);
    if (rel) {
        const n = Number(rel[1]);
        if (!Number.isFinite(n) || n <= 0)
            return undefined;
        const unit = rel[2].toLowerCase();
        const ms = unit === "m" ? n * 60_000 :
            unit === "h" ? n * 3_600_000 :
                unit === "d" ? n * 86_400_000 :
                    n * 604_800_000;
        const relativeDate = new Date(nowMs - ms);
        if (Number.isNaN(relativeDate.getTime()))
            return undefined;
        return relativeDate.toISOString();
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime()))
        return undefined;
    return d.toISOString();
}
// Parse a `--label-map` option into a translation table from pm tag/label
// names to GitHub label names. Accepts `from=to` pairs, comma-separated in a
// single value ("bug=kind/bug,enhancement=kind/enhancement") or repeated as an
// array. Entries without a `=` or with an empty side are skipped. Returns
// undefined when no usable mapping was provided so callers can short-circuit.
export function parseLabelMap(options, ...keys) {
    const lookup = keys.length > 0 ? keys : ["label-map", "labelMap"];
    const raw = optionCsv(options, ...lookup);
    if (raw.length === 0)
        return undefined;
    const map = new Map();
    for (const entry of raw) {
        const eq = entry.indexOf("=");
        if (eq <= 0)
            continue; // need a non-empty "from" before the '='
        const from = entry.slice(0, eq).trim();
        const to = entry.slice(eq + 1).trim();
        if (!from || !to)
            continue;
        map.set(from, to);
    }
    return map.size > 0 ? map : undefined;
}
// Apply a label translation table to a list of labels. Labels with a mapping
// are replaced; unmapped labels pass through unchanged. Two source labels that
// map to the same GitHub label are collapsed (GitHub rejects duplicate labels
// on an issue with a 422), preserving first-seen order.
export function applyLabelMap(labels, labelMap) {
    if (!labelMap || labelMap.size === 0)
        return labels;
    const out = [];
    const seen = new Set();
    for (const label of labels) {
        const mapped = labelMap.get(label) ?? label;
        if (seen.has(mapped))
            continue;
        seen.add(mapped);
        out.push(mapped);
    }
    return out;
}
// Parse one or more CSV-like option values into a deduplicated string list.
// Accepts a single string ("a,b") or repeated values (["a,b", "c"]).
export function optionCsv(options, ...keys) {
    const rawChunks = [];
    for (const k of keys) {
        const v = options[k];
        if (typeof v === "string") {
            rawChunks.push(v);
            continue;
        }
        if (Array.isArray(v)) {
            for (const entry of v) {
                if (typeof entry === "string")
                    rawChunks.push(entry);
            }
        }
    }
    const out = [];
    const seen = new Set();
    for (const chunk of rawChunks) {
        for (const piece of chunk.split(",")) {
            const id = piece.trim();
            if (!id || seen.has(id))
                continue;
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}
// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time — doubling side effects (e.g. a second GitHub fetch) and exiting
// with a generic code instead of a semantic one. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
export const EXIT_CODE = {
    GENERIC_FAILURE: 1,
    USAGE: 2,
    NOT_FOUND: 3,
};
/**
 * Error that carries a semantic process exit code.
 *
 * pm's command runtime treats a thrown error as a cleanly handled non-zero exit
 * only when it exposes a numeric `exitCode`; a plain `Error` instead falls
 * through to the "unhandled" path, which re-invokes the handler (doubling side
 * effects such as a second GitHub fetch) and exits with a generic code. Throwing
 * this routes a failure to a clean, single exit at the chosen code.
 */
export class CommandError extends Error {
    /** Numeric exit code the runtime propagates to the shell (one of {@link EXIT_CODE}). */
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
// ---------------------------------------------------------------------------
// Provenance — link a pm item back to a specific GitHub issue
// ---------------------------------------------------------------------------
/**
 * Build the `gh:owner/repo#N` provenance tag linking a pm item to a GitHub issue.
 *
 * The tag is the idempotency key: it round-trips losslessly through
 * `pm create --tags` / `pm list --json`, so a re-import can find the existing
 * item and UPDATE it instead of duplicating. Provenance also rides on declared
 * schema fields and the description, but the tag is what matching keys on.
 *
 * @param repo - `owner/repo`, lowercased into the tag.
 * @param issueNumber - The issue/PR number.
 * @returns The provenance tag string.
 */
export function provenanceTag(repo, issueNumber) {
    return `gh:${repo.toLowerCase()}#${issueNumber}`;
}
/**
 * Parse a `gh:owner/repo#N` provenance tag back into its repo and issue number.
 *
 * Returns `undefined` for anything that is not a provenance tag, so a caller
 * scanning a tag list can skip foreign tags without a try/catch.
 *
 * @param tag - The candidate tag string.
 * @returns The parsed repo (lowercased) and number, or `undefined`.
 */
export function parseProvenanceTag(tag) {
    const m = /^gh:([^#\s]+)#(\d+)$/.exec(tag.trim());
    if (!m)
        return undefined;
    return { repo: m[1].toLowerCase(), number: Number(m[2]) };
}
/**
 * Build the `github_author:login` tag recording who opened a GitHub issue.
 *
 * Mirrors how provenance rides on tags so the author survives a round-trip.
 * Returns `undefined` when the API supplied no usable login, so an empty tag is
 * never emitted.
 *
 * @param issue - The issue whose author to tag.
 * @returns The author tag, or `undefined`.
 */
export function authorTag(issue) {
    const login = issue.user?.login?.trim();
    if (!login)
        return undefined;
    return `github_author:${login}`;
}
// Narrow a set of pm items to explicit IDs. Unknown IDs are surfaced so
// command handlers can fail fast instead of silently ignoring typos.
export function scopeItemsByIds(items, ids) {
    if (!ids || ids.length === 0) {
        return { selected: [...items], missing: [] };
    }
    const wanted = new Set(ids);
    const selected = items.filter((item) => item.id && wanted.has(item.id));
    const found = new Set(selected
        .map((item) => item.id)
        .filter((id) => typeof id === "string"));
    const missing = ids.filter((id) => !found.has(id));
    return { selected, missing };
}
/** True only for a JSON object, excluding arrays and `null`. */
function isJsonRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Render an untrusted JSON value compactly inside a read-contract error. */
function describeJsonValue(value) {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? String(value) : rendered;
}
/** Require one exact field value from the `pm list --all` truthfulness envelope. */
function requireCompletePmField(actual, expected, field) {
    if (actual !== expected) {
        throw new CommandError(`Refusing unverifiable pm list --all output: ${field} must be ${describeJsonValue(expected)}; received ${describeJsonValue(actual)}.`);
    }
}
/** Installed CLI receipt version and command accepted by the complete reader. */
const COMPLETE_PM_READ_CONTRACT = {
    version: 1,
    command: "list",
};
/**
 * Build the canonical installed-CLI invocation for a whole-workspace read.
 *
 * The output controls are deliberately explicit. `list --all` includes terminal
 * items, `--output-include full` plus `--include-body` retains every field this
 * integration consumes, `--strict-read` rejects unreadable records, and both
 * amount and cost are unbounded. An arbitrary `--limit` must never be added:
 * callers use this corpus to prevent duplicate imports and missing syncs.
 *
 * @param pmRoot - Workspace or tracker root accepted by the pm CLI `--pm-path` flag.
 * @returns Argument vector passed to the installed `pm` executable.
 * @internal Exported so the acceptance test can bind the safety contract to the
 * exact production invocation; it is removed from the published declaration.
 */
export function completePmListArgs(pmRoot) {
    return [
        "--pm-path",
        pmRoot,
        "--output-include",
        "full",
        "--output-limit",
        "unbounded",
        "--output-budget",
        "unbounded",
        "list",
        "--all",
        "--json",
        "--include-body",
        "--strict-read",
    ];
}
/**
 * Decode only a complete, unbounded `pm list --all` response.
 *
 * The subprocess JSON is untrusted. This gate independently verifies every
 * completeness signal emitted by the current CLI, reconciles envelope counts,
 * rejects duplicate identities, and validates each field consumed by GitHub
 * import, export, state sync, Projects v2 sync, and search fallback paths.
 * Missing receipts fail closed because an unverifiable read is not a whole
 * workspace read.
 *
 * @param parsed - JSON decoded from the installed pm CLI.
 * @returns Fresh runtime-validated item objects.
 * @throws {@link CommandError} When a receipt, count, identity, or consumed row
 * field is absent, incomplete, or contradictory.
 * @internal Exported for direct adversarial contract tests and stripped from
 * the published declaration surface.
 */
export function decodeCompletePmItems(parsed) {
    if (!isJsonRecord(parsed)) {
        throw new CommandError("Refusing unverifiable pm list --all output: the response must be a top-level object with completeness receipts.");
    }
    if (!Array.isArray(parsed.items)) {
        throw new CommandError("Refusing unverifiable pm list --all output: items must be an array.");
    }
    requireCompletePmField(parsed.truncated, false, "truncated");
    requireCompletePmField(parsed.has_more, false, "has_more");
    requireCompletePmField(parsed.next_cursor, null, "next_cursor");
    const completeness = isJsonRecord(parsed.completeness) ? parsed.completeness : {};
    requireCompletePmField(completeness.status, "complete", "completeness.status");
    requireCompletePmField(completeness.unreadable_item_count, 0, "completeness.unreadable_item_count");
    requireCompletePmField(completeness.unreadable_directory_count, 0, "completeness.unreadable_directory_count");
    const omission = isJsonRecord(parsed.omission_receipt) ? parsed.omission_receipt : {};
    requireCompletePmField(omission.has_omissions, false, "omission_receipt.has_omissions");
    requireCompletePmField(omission.omitted_field_group_count, 0, "omission_receipt.omitted_field_group_count");
    if (!Array.isArray(omission.omitted_field_groups) || omission.omitted_field_groups.length !== 0) {
        throw new CommandError("Refusing unverifiable pm list --all output: omission_receipt.omitted_field_groups must be empty.");
    }
    const projection = isJsonRecord(parsed.projection) ? parsed.projection : {};
    requireCompletePmField(projection.mode, "full", "projection.mode");
    const readOutput = isJsonRecord(parsed.read_output) ? parsed.read_output : {};
    requireCompletePmField(readOutput.contract_version, COMPLETE_PM_READ_CONTRACT.version, "read_output.contract_version");
    requireCompletePmField(readOutput.command, COMPLETE_PM_READ_CONTRACT.command, "read_output.command");
    requireCompletePmField(readOutput.within_budget, true, "read_output.within_budget");
    requireCompletePmField(readOutput.strings_compacted, false, "read_output.strings_compacted");
    requireCompletePmField(readOutput.rows_compacted, false, "read_output.rows_compacted");
    requireCompletePmField(readOutput.result_omitted, false, "read_output.result_omitted");
    if (!Array.isArray(readOutput.requested_dimensions)
        || !readOutput.requested_dimensions.includes("include")
        || !readOutput.requested_dimensions.includes("amount")
        || !readOutput.requested_dimensions.includes("cost")) {
        throw new CommandError("Refusing unverifiable pm list --all output: read_output.requested_dimensions must include include, amount, and cost.");
    }
    if ("output_budget_truncation" in parsed || "output_budget_exceeded" in parsed) {
        throw new CommandError("Refusing unverifiable pm list --all output: a budget truncation or omission disclosure was present.");
    }
    if (!Number.isSafeInteger(parsed.count) || parsed.count < 0) {
        throw new CommandError(`Refusing unverifiable pm list --all output: count must be a non-negative safe integer; received ${describeJsonValue(parsed.count)}.`);
    }
    if (!Number.isSafeInteger(parsed.total) || parsed.total < 0) {
        throw new CommandError(`Refusing unverifiable pm list --all output: total must be a non-negative safe integer; received ${describeJsonValue(parsed.total)}.`);
    }
    if (parsed.items.length !== parsed.count) {
        throw new CommandError(`Refusing unverifiable pm list --all output: items.length ${parsed.items.length} must equal count ${String(parsed.count)}.`);
    }
    if (parsed.count !== parsed.total) {
        throw new CommandError(`Refusing incomplete pm list --all output: count ${String(parsed.count)} must equal total ${String(parsed.total)}.`);
    }
    const ids = new Set();
    const items = [];
    for (const [index, item] of parsed.items.entries()) {
        if (!isJsonRecord(item)) {
            throw new CommandError(`Refusing unverifiable pm list --all output: item ${index} must be an object.`);
        }
        if (typeof item.id !== "string" || item.id.trim().length === 0) {
            throw new CommandError(`Refusing unverifiable pm list --all output: item ${index} must have a non-empty id.`);
        }
        if (ids.has(item.id)) {
            throw new CommandError(`Refusing unverifiable pm list --all output: duplicate item id ${item.id}.`);
        }
        const title = item.title;
        const status = item.status;
        const body = item.body;
        const description = item.description;
        if (typeof title !== "string") {
            throw new CommandError(`Refusing unverifiable pm list --all output: item ${item.id} title must be a string.`);
        }
        if (typeof status !== "string") {
            throw new CommandError(`Refusing unverifiable pm list --all output: item ${item.id} status must be a string.`);
        }
        if (typeof body !== "string") {
            throw new CommandError(`Refusing unverifiable pm list --all output: item ${item.id} body must be a string.`);
        }
        if (typeof description !== "string") {
            throw new CommandError(`Refusing unverifiable pm list --all output: item ${item.id} description must be a string.`);
        }
        if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string")) {
            throw new CommandError(`Refusing unverifiable pm list --all output: item ${item.id} tags must be an array of strings.`);
        }
        ids.add(item.id);
        items.push({
            id: item.id,
            title,
            status,
            body,
            description,
            tags: [...item.tags],
        });
    }
    return items;
}
/**
 * Read every pm item, including terminal items, through a proven-complete CLI response.
 *
 * The enlarged byte buffer prevents Node's default 1 MiB cap from killing a
 * mature tracker, while {@link decodeCompletePmItems} refuses any successful
 * process response that does not prove the entire item corpus and every
 * consumed field were returned intact.
 *
 * @param pmRoot - Workspace or tracker root accepted by the pm CLI.
 * @param platform - Runtime platform; injectable only to exercise the secure
 * Windows launcher strategy on non-Windows CI.
 * @param pmPackageRoot - Host pm CLI package root from `PM_CLI_PACKAGE_ROOT`;
 * injectable only to reproduce installed-extension layout in tests.
 * @returns The complete runtime-validated item corpus.
 * @throws {@link CommandError} On process, buffer, JSON, or completeness failure.
 * @internal Exported for installed-CLI acceptance and stripped from the public declaration.
 */
export function readPmItems(pmRoot, platform = process.platform, pmPackageRoot = process.env.PM_CLI_PACKAGE_ROOT) {
    const maxBuffer = pmJsonMaxBuffer();
    const listArgs = completePmListArgs(pmRoot);
    let command = "pm";
    let args = listArgs;
    if (platform === "win32") {
        if (typeof pmPackageRoot !== "string" || pmPackageRoot.trim().length === 0) {
            throw new CommandError("The pm host did not publish PM_CLI_PACKAGE_ROOT for a secure Windows CLI relaunch.");
        }
        const hostRoot = path.resolve(pmPackageRoot.trim());
        const packageJsonPath = path.join(hostRoot, "package.json");
        let packageMetadata;
        try {
            packageMetadata = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        }
        catch {
            throw new CommandError("Could not read the installed pm CLI package metadata.");
        }
        const bin = isJsonRecord(packageMetadata) && isJsonRecord(packageMetadata.bin)
            ? packageMetadata.bin.pm
            : undefined;
        if (typeof bin !== "string" || bin.trim().length === 0) {
            throw new CommandError("The installed pm CLI package does not declare its pm executable.");
        }
        const cliEntry = path.resolve(hostRoot, bin);
        const relativeEntry = path.relative(hostRoot, cliEntry);
        if (relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
            throw new CommandError("The installed pm CLI package declares an executable outside its package root.");
        }
        command = process.execPath;
        args = [cliEntry, ...listArgs];
    }
    const result = spawnSync(command, args, { encoding: "utf-8", maxBuffer });
    // A buffer overrun kills the child with status null and no stderr, so name the
    // real cause instead of reporting an unexplained failure.
    if (result.error) {
        const code = result.error.code;
        if (code === "ENOBUFS") {
            throw new CommandError(`pm list --all output exceeded the ${maxBuffer} byte read buffer. ` +
                "The complete corpus cannot be narrowed safely. Only raise the " +
                "PM_JSON_MAX_BUFFER env var after confirming the workspace size and available memory.");
        }
        throw new CommandError(`pm list --all failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new CommandError(result.stderr || "pm list --all failed");
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        throw new CommandError("Could not parse `pm list --all --json` output.");
    }
    return decodeCompletePmItems(parsed);
}
// Index existing pm items by their GitHub provenance tag for O(1) idempotent
// matching on re-import.
/**
 * Narrow one runtime search document to a {@link PmItem}.
 *
 * The SDK declares `SearchProviderQueryContext.documents` as `ItemDocument[]`
 * with a REQUIRED `metadata`, but the runtime also hands raw pm items straight
 * through on some paths — `SearchProviderQueryContext` carries an
 * `[key: string]: unknown` index signature, so its shape is looser than the
 * declared type. Trusting `d.metadata` unconditionally therefore yields
 * `undefined` entries and crashes `indexByProvenance` with a TypeError; the
 * pre-typing code guarded this with `d?.metadata ? d.metadata : d`, and that
 * guard is preserved here rather than dropped in the name of the declared type.
 * Anything matching neither shape is skipped instead of poisoning the index.
 */
export function searchDocumentToItem(document) {
    if (!document || typeof document !== "object")
        return undefined;
    const wrapped = document.metadata;
    if (wrapped && typeof wrapped === "object")
        return wrapped;
    return "id" in document ? document : undefined;
}
/**
 * Resolve the corpus the search provider matches remote hits against.
 *
 * Prefers the runtime-provided documents (already the current corpus) and falls
 * back to a fresh workspace read when absent. This is the provider's REAL mapping,
 * extracted so it is directly testable: the surrounding `query` handler performs
 * network I/O first, so an end-to-end test cannot reach the mapping without
 * stubbing internals, and an inline expression would be untestable in practice.
 */
export function resolveSearchCorpus(documents, pmRootValue) {
    const pmRoot = typeof pmRootValue === "string" && pmRootValue ? pmRootValue : ".agents/pm";
    if (!Array.isArray(documents))
        return readPmItems(pmRoot);
    return documents
        .map((document) => searchDocumentToItem(document))
        .filter((item) => item !== undefined);
}
/**
 * Index complete pm items by their normalized GitHub issue provenance.
 *
 * Items without a stable local id or a valid `gh:owner/repo#N` tag are skipped.
 * When legacy data contains duplicate provenance, the last corpus row wins;
 * the complete reader prevents duplicate local item ids separately.
 *
 * @param items - Complete runtime-validated pm item corpus.
 * @returns Map keyed by lowercase `owner/repo#N` provenance.
 */
export function indexByProvenance(items) {
    const index = new Map();
    for (const item of items) {
        for (const tag of item.tags ?? []) {
            const p = parseProvenanceTag(tag);
            if (p && item.id)
                index.set(`${p.repo}#${p.number}`, item);
        }
    }
    return index;
}
// ---------------------------------------------------------------------------
// Atomic GitHub issue import (pm-cli >= 2026.7.20 commitItemMutations)
// ---------------------------------------------------------------------------
// Node's spawnSync defaults to a 1 MiB stdout cap. A mature tracker's full JSON
// dump (`pm --output-include full list --all --include-body`) passes that at a few hundred items,
// and the child is then killed with ENOBUFS, status null and EMPTY stderr — which
// surfaced as a bare "pm list --all failed" with nothing to diagnose. Reproduced on
// a real 443-item workspace at 1,052,859 bytes. 64 MiB matches the cap the sibling
// pm packages settled on (pm-changelog, pm-context, pm-brief).
/** Read-buffer cap for `pm` output, in bytes. 64 MiB by default; override with the
 * `PM_JSON_MAX_BUFFER` env var. Resolved per call so the override takes effect
 * without an import-order dependency. Invalid or non-positive values fall back to
 * the default rather than silently disabling the guard. */
function pmJsonMaxBuffer() {
    // Number(), not parseInt(): parseInt("64MiB") silently yields 64, which would
    // impose a 64-BYTE cap and break every ordinary read while appearing to honor
    // the documented invalid-value fallback. Number() rejects the whole string.
    const raw = Number(process.env.PM_JSON_MAX_BUFFER);
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 64 * 1024 * 1024;
}
const ATOMIC_IMPORT_PREFIX = "github-import-";
let cachedCommitItemMutations;
function assertSdkFunction(fn, exportName) {
    if (typeof fn !== "function") {
        throw new CommandError(`--atomic requires @unbrained/pm-cli>=2026.7.20 with the commitItemMutations SDK primitive, but the installed SDK does not export ${exportName} as a function. Upgrade @unbrained/pm-cli to >=2026.7.20.`, EXIT_CODE.USAGE);
    }
    return fn;
}
/** Resolve the atomic bulk-mutation helper. Accepts an optional SDK override for
 * tests that simulate a missing export; the default path uses the top-level
 * imported `commitItemMutations` so normal imports never touch the dynamic
 * loader. */
export async function resolveCommitItemMutations(importSdk) {
    if (importSdk) {
        const mod = await importSdk();
        return assertSdkFunction(mod.commitItemMutations, "commitItemMutations");
    }
    if (cachedCommitItemMutations)
        return cachedCommitItemMutations;
    cachedCommitItemMutations = assertSdkFunction(sdkCommitItemMutations, "commitItemMutations");
    return cachedCommitItemMutations;
}
async function resolveAtomicSdkFunctions(opts) {
    const needsSdk = !opts.commitItemMutations || !opts.normalizeItemId || !opts.readSettings;
    return {
        commitItemMutations: opts.commitItemMutations ?? assertSdkFunction(needsSdk ? sdkCommitItemMutations : undefined, "commitItemMutations"),
        normalizeItemId: opts.normalizeItemId ?? assertSdkFunction(needsSdk ? sdkNormalizeItemId : undefined, "normalizeItemId"),
        readSettings: opts.readSettings ?? assertSdkFunction(needsSdk ? sdkReadSettings : undefined, "readSettings"),
    };
}
/**
 * Derive an order-independent transaction id from the desired import state and
 * exact ordered mutation plan. Content or target changes produce a fresh
 * transaction; a reordered retry of the same plan resumes the durable journal.
 */
export function deriveAtomicTransactionId(repo, entries, mutations) {
    const canonical = [...entries]
        .sort((a, b) => a.issueNumber - b.issueNumber)
        .map((entry) => ({
        issueNumber: entry.issueNumber,
        title: entry.title,
        itemType: entry.itemType,
        status: entry.status,
        description: entry.description,
        body: entry.body,
        tags: [...entry.tags].sort(),
        assignee: entry.assignee ?? null,
        milestone: entry.milestone ?? null,
    }));
    const digest = crypto
        .createHash("sha256")
        .update(repo.toLowerCase())
        .update("\x1f")
        .update(JSON.stringify(canonical))
        .update("\x1f")
        // Recovery requires the exact ordered step plan. Include targets and
        // options so a changed id_prefix or provenance match gets a fresh journal
        // instead of colliding with an incompatible prior attempt.
        .update(JSON.stringify(mutations))
        .digest("hex")
        .slice(0, 16);
    return `${ATOMIC_IMPORT_PREFIX}${digest}`;
}
/** Stable create id keyed by the external GitHub issue, never by fetch order. */
export function deriveAtomicItemId(repo, issueNumber, idPrefix, normalizeItemId) {
    const repoToken = crypto
        .createHash("sha256")
        .update(repo.toLowerCase())
        .digest("hex")
        .slice(0, 12);
    return normalizeItemId(`github-${repoToken}-${issueNumber}`, idPrefix);
}
/** Map one rendered import entry to its reversible SDK mutation sequence. */
export function buildAtomicImportMutations(repo, entry, idPrefix, normalizeItemId) {
    const sharedOptions = {
        title: entry.title,
        type: entry.itemType,
        description: entry.description,
        body: entry.body,
        tags: entry.tags.join(","),
        ...(entry.assignee ? { assignee: entry.assignee } : {}),
        ...(entry.milestone ? { sprint: entry.milestone } : {}),
    };
    const managedItemId = deriveAtomicItemId(repo, entry.issueNumber, idPrefix, normalizeItemId);
    // A missing match and a match at our deterministic external-key id use the
    // SAME create+update upsert plan. This is essential for crash recovery: if a
    // prior attempt stopped after create, the next provenance scan sees that
    // item, but commitItemMutations must still receive the original plan. The
    // create step treats an existing stable id as already applied; update then
    // makes later content-bearing transactions refresh the item normally.
    if (!entry.match?.id || entry.match.id === managedItemId) {
        const createStatus = entry.status === "closed" ? "open" : entry.status;
        const mutations = [{
                op: "create",
                id: managedItemId,
                options: { ...sharedOptions, status: createStatus },
            }, {
                op: "update",
                id: managedItemId,
                options: {
                    ...sharedOptions,
                    ...(entry.status !== "closed" ? { status: entry.status } : {}),
                },
            }];
        if (entry.status === "closed") {
            mutations.push({
                op: "close",
                id: managedItemId,
                reason: `GitHub issue #${entry.issueNumber} closed`,
                // Preserve the source's real completion time instead of the import time.
                ...(entry.closedAt ? { options: { completedAt: entry.closedAt } } : {}),
            });
        }
        return {
            itemId: managedItemId,
            mutations,
        };
    }
    const itemId = entry.match.id;
    const updateOptions = { ...sharedOptions };
    // close has a dedicated mutation so its reason is preserved. Every other
    // transition (open/reopen/canceled) is safely reversible as part of update.
    if (entry.status !== "closed") {
        updateOptions.status = entry.status;
    }
    const mutations = [{
            op: "update",
            id: itemId,
            options: updateOptions,
        }];
    if (entry.status === "closed") {
        mutations.push({
            op: "close",
            id: itemId,
            reason: `GitHub issue #${entry.issueNumber} closed`,
            // Preserve the source's real completion time instead of the import time.
            ...(entry.closedAt ? { options: { completedAt: entry.closedAt } } : {}),
        });
    }
    return { itemId, mutations };
}
/** Commit a complete issue-import batch under one crash-resumable transaction. */
export async function importGithubAtomic(pmRoot, repo, entries, opts = {}) {
    const { commitItemMutations: commit, normalizeItemId, readSettings, } = await resolveAtomicSdkFunctions(opts);
    let idPrefix = "pm-";
    try {
        const settings = await readSettings(pmRoot);
        if (settings?.id_prefix)
            idPrefix = String(settings.id_prefix);
    }
    catch {
        // Match normal import resilience: an unreadable optional setting falls
        // back to the canonical prefix; the mutation still validates the tracker.
    }
    const mutations = [];
    const itemIds = new Map();
    // The transaction journal fingerprints the ordered step plan. Canonicalize
    // by the stable GitHub issue number so a retry whose API page/order changed
    // supplies the exact same plan as well as the same transaction id.
    for (const entry of [...entries].sort((a, b) => a.issueNumber - b.issueNumber)) {
        const planned = buildAtomicImportMutations(repo, entry, idPrefix, normalizeItemId);
        itemIds.set(entry.issueNumber, planned.itemId);
        mutations.push(...planned.mutations);
    }
    const transactionId = deriveAtomicTransactionId(repo, entries, mutations);
    try {
        const result = await commit({
            pmRoot,
            transactionId,
            author: opts.atomicAuthor ?? "pm-github",
            mutations,
            // This option selects how CREATE steps are compensated. The SDK's
            // commitItemMutations contract independently snapshots and version-
            // restores every UPDATE and CLOSE step (covered by the mixed rollback
            // integration test below this implementation).
            createCompensation: "delete",
        });
        // A recovered journal may include work applied by the interrupted process
        // as well as steps resumed now. The SDK intentionally returns the durable
        // final results, not a per-invocation delta, so create/update counts cannot
        // be reconstructed truthfully. Report the recovered batch separately.
        const recovered = Boolean(result?.recovered);
        return {
            transactionId,
            recovered,
            imported: recovered ? 0 : entries.filter((entry) => !entry.match?.id).length,
            updated: recovered ? 0 : entries.filter((entry) => Boolean(entry.match?.id)).length,
            ...(recovered ? { recoveredItems: entries.length } : {}),
            itemIds,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof AggregateError || /compensation failed/i.test(msg)) {
            throw new CommandError(`Atomic GitHub import failed and compensation was incomplete. The tracker may contain partially applied state; retry the same import to resume transaction ${transactionId}, then inspect its durable journal if recovery still fails. Underlying error: ${msg}`, EXIT_CODE.GENERIC_FAILURE);
        }
        if (err instanceof Error && err.name === "WorkspaceTransactionInterruptedError") {
            throw new CommandError(`Atomic GitHub import was interrupted. Its durable journal is resumable; retry the same import to continue transaction ${transactionId}. Underlying error: ${msg}`, EXIT_CODE.GENERIC_FAILURE);
        }
        throw new CommandError(`Atomic GitHub import failed after the SDK completed its normal compensation path; no new partial committed state is expected. Transaction id: ${transactionId}. Underlying error: ${msg}`, EXIT_CODE.GENERIC_FAILURE);
    }
}
// ---------------------------------------------------------------------------
// Shared import core (used by both the legacy command and the importer)
// ---------------------------------------------------------------------------
// Build the GitHub issues list URL. `since`, `assignee`, `labels` and `state`
// are honored server-side; `milestone` is filtered client-side (the REST API
// keys milestones by number, not title).
export function buildIssuesUrl(repo, opts) {
    let url = `${githubApiBase()}/repos/${repo}/issues?state=${opts.state}&per_page=100`;
    if (opts.labels)
        url += `&labels=${encodeURIComponent(opts.labels)}`;
    if (opts.since)
        url += `&since=${encodeURIComponent(opts.since)}`;
    if (opts.assignee)
        url += `&assignee=${encodeURIComponent(opts.assignee)}`;
    return url;
}
/**
 * Page through GitHub's issues REST endpoint, following the Link header, applying
 * the import filters, and returning the full issue list.
 *
 * @internal Exported only so the HTTP-boundary tests can drive the real client.
 * `stripInternal` keeps it out of the published `.d.ts`, so this is NOT a public API
 * commitment and must not be relied on from outside this package.
 */
export async function fetchAllIssues(repo, opts, token) {
    const issues = [];
    let nextUrl = buildIssuesUrl(repo, opts);
    while (nextUrl) {
        const { body, linkHeader } = await fetchJSON(nextUrl, token);
        let page;
        try {
            page = JSON.parse(body);
        }
        catch {
            throw new Error("Invalid JSON response from GitHub.");
        }
        if (!Array.isArray(page)) {
            throw new Error("Unexpected GitHub API response (expected an array of issues).");
        }
        issues.push(...page);
        nextUrl = parseNextLink(linkHeader);
    }
    return issues;
}
/**
 * Fetch all review comments for a single issue or PR, paging through the Link header.
 *
 * @internal Exported only so the HTTP-boundary tests can drive the real client.
 * `stripInternal` keeps it out of the published `.d.ts`, so this is NOT a public API
 * commitment and must not be relied on from outside this package.
 */
export async function fetchComments(issue, repo, token) {
    if (!issue.comments || issue.comments <= 0)
        return [];
    const comments = [];
    let nextUrl = issue.comments_url ||
        `${githubApiBase()}/repos/${repo}/issues/${issue.number}/comments?per_page=100`;
    while (nextUrl) {
        const { body, linkHeader } = await fetchJSON(nextUrl, token);
        let page;
        try {
            page = JSON.parse(body);
        }
        catch {
            break;
        }
        if (!Array.isArray(page))
            break;
        comments.push(...page);
        nextUrl = parseNextLink(linkHeader);
    }
    return comments;
}
// Compose the pm item body for an issue, optionally appending its comments.
export function composeBody(issue, comments) {
    let body = issue.body || "";
    if (comments.length > 0) {
        const rendered = comments
            .map((c) => {
            const who = c.user?.login ?? "unknown";
            const when = c.created_at ? ` (${c.created_at})` : "";
            return `> **@${who}**${when}\n>\n${(c.body || "").split("\n").map((l) => `> ${l}`).join("\n")}`;
        })
            .join("\n\n");
        body = `${body}\n\n---\n\n### GitHub comments (${comments.length})\n\n${rendered}`.trim();
    }
    return body;
}
// ---------------------------------------------------------------------------
// Cross-process comment-sync lock (serializes marker dedupe, pm-github-503u)
// ---------------------------------------------------------------------------
//
// The native comment sync below does a read-markers-then-append sequence that
// spans several pm CLI mutations. Each individual mutation is locked by the pm
// CLI, but the check-then-act as a whole is not atomic across two concurrent
// `pm github import` processes on the same workspace: both can observe a
// GitHub comment id as absent and append it twice. The helper here closes that
// race with a lockfile in the workspace's own locks/ dir, following the pm
// CLI's locking convention (see core/lock/lock.js in pm-cli):
//
//   - location  <pm data dir>/locks/pm-github.comment-sync.<itemId>.lock — the
//     same locks/ dir the pm CLI itself uses (gitignored runtime state), with
//     a payload shape identical to the CLI's so `pm gc` can sweep our stale
//     locks by their embedded ttl_seconds. The "pm-github.comment-sync."
//     prefix keeps our namespace disjoint from the CLI's per-item mutation
//     locks (<itemId>.lock): we hold our lock ACROSS several CLI mutations, so
//     sharing a name would make the very mutations we wrap conflict with it.
//   - acquire   fs.openSync(path, "wx") — atomic O_EXCL create on POSIX.
//   - stale     a lock is broken (with a stderr warning) only when its owner
//     is provably gone: the recorded owner PID is dead, or it equals our own
//     PID (we know we don't hold it, so the PID was recycled). A lock with a
//     LIVE owner is never age-broken — a slow-but-alive holder keeps its lock
//     no matter how long it runs (a >TTL holder would otherwise lose the lock
//     mid-append and the race would reopen). Only when the payload is missing
//     or unparseable (caught mid-write, then abandoned) does the TTL (default
//     5 min, age from file mtime) apply as the break criterion.
//   - release   token-checked: each acquisition embeds a unique token in the
//     payload and release() unlinks the file only while it still carries that
//     token, so a holder whose lock was stale-broken (or swept by `pm gc`)
//     can never unlink a successor's lock.
//   - breaking  stale locks are removed under a breaker election (an O_EXCL
//     `<lock>.break` sidecar): only the single election winner may unlink,
//     and it re-verifies staleness under that mutex first — two concurrent
//     breakers can therefore never double-break, and a breaker can never
//     unlink a fresh lock that replaced the stale one it inspected.
//   - contend   a live, fresh lock is waited out with jittered backoff up to a
//     budget (default 30s). On timeout the caller reports "contended" and the
//     comment sync for that item is SKIPPED (never run unlocked) — a wedged
//     concurrent import can then cost a comment sync, recoverable by
//     re-running import, but can never produce a duplicate comment. When the
//     lock mechanism itself is unavailable (read-only fs etc.) the caller
//     reports "degraded" and proceeds unlocked with a warning, matching the
//     pre-lock best-effort behavior.
export const IMPORT_LOCK_TTL_MS_DEFAULT = 5 * 60_000;
/** Default total budget a caller waits to acquire a contended comment-sync lock before giving up and skipping that item's sync. */
export const IMPORT_LOCK_WAIT_MS_DEFAULT = 30_000;
/**
 * Resolve the pm data dir from the `pmRoot` a command handler receives.
 *
 * The host may hand either the workspace root (the dir containing `.agents/pm`)
 * or the data dir itself — the pm CLI accepts both for `--path`. This returns
 * the dir that actually holds `settings.json` and `locks/`, defaulting to
 * `pmRoot` unchanged when no nested `.agents/pm` exists.
 *
 * @param pmRoot - The path supplied by the extension host.
 * @returns The resolved pm data directory.
 */
export function resolvePmDataDir(pmRoot) {
    const nested = path.join(pmRoot, ".agents", "pm");
    try {
        if (fs.statSync(nested).isDirectory())
            return nested;
    }
    catch {
        // Not the workspace-root form — assume pmRoot already is the data dir.
    }
    return pmRoot;
}
/**
 * Absolute lock file path for one item's comment-sync critical section.
 *
 * The item id is sanitized defensively: pm ids are already filename-safe, but
 * the lock path must never become a directory-traversal vector if that ever
 * changes.
 *
 * @param pmRoot - Workspace root or pm data dir.
 * @param itemId - The pm item id to serialize.
 * @returns Absolute path under the data dir's `locks/` directory.
 */
export function importCommentSyncLockPath(pmRoot, itemId) {
    const safe = itemId.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(resolvePmDataDir(pmRoot), "locks", `pm-github.comment-sync.${safe}.lock`);
}
/**
 * Read and parse a lock file's payload.
 *
 * Returns `undefined` when the file is absent or holds non-JSON / non-object
 * content (e.g. caught mid-write then abandoned), so the caller treats an
 * unreadable lock as owner-less rather than crashing.
 *
 * @param lockPath - Absolute lock file path.
 * @returns The parsed payload, or `undefined`.
 */
function readImportLockPayload(lockPath) {
    let raw;
    try {
        raw = fs.readFileSync(lockPath, "utf8");
    }
    catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
/**
 * Whether the process holding a lock is still running.
 *
 * Signals the PID with signal 0 (no effect); `EPERM` means the process exists
 * but belongs to another user (still alive), while `ESRCH` means it is gone.
 * Non-numeric or non-positive PIDs are treated as not-alive.
 *
 * @param pid - The recorded owner PID (untyped at the call site).
 * @returns True when the PID names a live process.
 */
function isLockOwnerAlive(pid) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        // EPERM means the process exists but belongs to another user — still alive.
        // ESRCH means no such process — the lock owner is gone.
        return err?.code === "EPERM";
    }
}
// A held lock is stale only when its owner is provably gone: the recorded
// owner PID is dead (crash without release), or it equals our own PID (we
// know we do not hold this lock, so the PID must have been recycled). A lock
// with a LIVE recorded owner is never age-broken — breaking a slow-but-alive
// holder mid-critical-section would reopen the duplicate-marker race this
// lock exists to close. Only when there is no usable owner PID (payload
// missing or unparseable — e.g. caught mid-write, then abandoned) does the
// TTL apply, with age taken from the payload's created_at falling back to
// the file mtime. (PID reuse can make a dead lock look alive and thus block
// until the wait budget — conservative; it can never break a live one.)
// Lock paths currently held by THIS process (any async task). Distinguishes a
// same-pid payload that is legitimately ours (in-process contention → wait)
// from a leftover written by a dead process whose PID we inherited (→ break).
const heldImportLocks = new Set();
/**
 * Decide whether a held lock is stale and why.
 *
 * Returns a human-readable reason when the lock should be broken, or
 * `undefined` when it is still legitimately held. A lock is stale only when its
 * owner is provably gone: the recorded PID is dead, or it equals our own PID on
 * a path this process does not hold (a recycled PID). A LIVE owner is never
 * age-broken; only a missing/unparseable payload falls back to the TTL, aged
 * from `created_at` or the file mtime.
 *
 * @param lockPath - Absolute lock file path (also tracked in {@link heldImportLocks}).
 * @param payload - Parsed lock payload, or `undefined` when unreadable.
 * @param mtimeMs - File mtime, the age fallback base.
 * @param ttlMs - Maximum age before an owner-less lock is considered stale.
 * @returns The staleness reason, or `undefined` when the lock is live.
 */
function importLockStaleReason(lockPath, payload, mtimeMs, ttlMs) {
    const pid = payload?.pid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
        if (pid === process.pid) {
            // Our own PID: either another async task in THIS process holds it (the
            // in-process race the caller serializes too — contend, don't break), or
            // we provably don't hold it and the PID was recycled by a dead owner.
            return heldImportLocks.has(lockPath)
                ? undefined
                : `owner pid ${pid} is this process but the lock is not held in-process (pid recycled, lock abandoned)`;
        }
        return isLockOwnerAlive(pid) ? undefined : `owner pid ${pid} is dead`;
    }
    const createdMs = payload ? Date.parse(payload.created_at) : Number.NaN;
    const ageBase = Number.isFinite(createdMs) ? createdMs : mtimeMs;
    if (!Number.isFinite(ageBase) || Date.now() - ageBase > ttlMs) {
        return `no usable owner pid and older than TTL ${Math.round(ttlMs / 1000)}s`;
    }
    return undefined;
}
const IMPORT_LOCK_INITIAL_BACKOFF_MS = 25;
const IMPORT_LOCK_MAX_BACKOFF_MS = 200;
const IMPORT_LOCK_MAX_STALE_BREAKS = 3;
/**
 * Staleness TTL for a breaker election sidecar, in ms.
 *
 * A breaker's critical section is a handful of syscalls (re-stat, re-read,
 * unlink), so a crashed breaker's sidecar goes stale in seconds, not minutes;
 * this short window lets a contender clear and re-run a dead election.
 */
export const IMPORT_LOCK_BREAKER_TTL_MS = 10_000;
/**
 * Break a stale lock under a breaker election.
 *
 * Two contenders may both judge the same file stale; without mutual exclusion
 * the slower unlink would remove a fresh, live lock the winner had just
 * re-created — the exact double-acquire this module exists to prevent. The
 * election is an O_EXCL sidecar (`<lock>.break`): only its single winner may
 * unlink, and it re-verifies staleness under that mutex first, so a lock that
 * became live since the caller's check survives.
 *
 * @param lockPath - Absolute path of the lock judged stale.
 * @param ttlMs - Staleness TTL handed to {@link importLockStaleReason} on re-check.
 * @param reason - Human-readable staleness reason, surfaced in the break warning.
 * @returns True when the stale lock was removed (retry acquire now); false when the election was lost or the lock is live again.
 */
function breakStaleImportLock(lockPath, ttlMs, reason) {
    const breakerPath = `${lockPath}.break`;
    let bfd;
    try {
        bfd = fs.openSync(breakerPath, "wx");
    }
    catch (err) {
        if (err?.code === "EEXIST") {
            // Another breaker is active. If IT crashed mid-break, its sidecar is
            // old — clear it and let the next iteration re-run the election.
            try {
                if (Date.now() - fs.statSync(breakerPath).mtimeMs > IMPORT_LOCK_BREAKER_TTL_MS) {
                    fs.unlinkSync(breakerPath);
                }
            }
            catch {
                // Sidecar vanished (election finished) — retry normally.
            }
        }
        return false;
    }
    try {
        fs.closeSync(bfd);
        // Re-verify under the mutex: the lock we judged stale may have been
        // broken and re-acquired by a live owner since we looked at it.
        let payload;
        let mtimeMs = Number.NaN;
        try {
            mtimeMs = fs.statSync(lockPath).mtimeMs;
            payload = readImportLockPayload(lockPath);
        }
        catch {
            return true; // already gone — acquire can proceed immediately
        }
        if (!importLockStaleReason(lockPath, payload, mtimeMs, ttlMs))
            return false;
        console.error(`pm-github: breaking stale comment-sync lock ${lockPath} (${reason})`);
        try {
            fs.unlinkSync(lockPath);
        }
        catch {
            // Already gone.
        }
        return true;
    }
    finally {
        try {
            fs.unlinkSync(breakerPath);
        }
        catch {
            // Best-effort: an aged-out sidecar may have been cleared by a peer.
        }
    }
}
/**
 * Acquire the cross-process comment-sync lock for one item.
 *
 * Never throws: every failure mode maps to one of the three acquisition
 * statuses (`acquired`, `contended`, `degraded`) so the caller decides how to
 * degrade. `ttlMs`/`waitMs` are injectable so the wait and staleness windows
 * can be exercised without real timing in tests.
 *
 * @param pmRoot - Workspace root or pm data dir passed to {@link resolvePmDataDir}.
 * @param itemId - The pm item whose comment critical section is serialized.
 * @param opts - Optional overrides for the staleness TTL and wait budget.
 * @returns The acquisition outcome.
 */
export async function acquireImportLock(pmRoot, itemId, opts = {}) {
    const ttlMs = opts.ttlMs ?? IMPORT_LOCK_TTL_MS_DEFAULT;
    const waitMs = opts.waitMs ?? IMPORT_LOCK_WAIT_MS_DEFAULT;
    let lockPath;
    try {
        lockPath = importCommentSyncLockPath(pmRoot, itemId);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`pm-github: comment-sync lock unavailable (${msg}) — proceeding without cross-process serialization`);
        return { status: "degraded" };
    }
    const payload = {
        id: path.basename(lockPath, ".lock"),
        pid: process.pid,
        owner: "pm-github",
        token: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ttl_seconds: Math.ceil(ttlMs / 1000),
    };
    const startedAt = Date.now();
    let backoffMs = IMPORT_LOCK_INITIAL_BACKOFF_MS;
    let staleBreaks = 0;
    for (;;) {
        let fd;
        try {
            fd = fs.openSync(lockPath, "wx");
            fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
            fs.closeSync(fd);
            fd = undefined;
            heldImportLocks.add(lockPath);
            let released = false;
            return {
                status: "acquired",
                lock: {
                    path: lockPath,
                    release() {
                        if (released)
                            return;
                        released = true;
                        heldImportLocks.delete(lockPath);
                        try {
                            // Token check: only unlink the file while it is still OUR lock.
                            // If it was stale-broken or gc-swept and re-acquired, the path
                            // now holds the successor's lock — leave it alone.
                            const current = readImportLockPayload(lockPath);
                            if (current?.token !== payload.token)
                                return;
                            fs.unlinkSync(lockPath);
                        }
                        catch {
                            // Best-effort: already gone (stale-broken by someone else, gc).
                        }
                    },
                },
            };
        }
        catch (err) {
            if (fd !== undefined) {
                try {
                    fs.closeSync(fd);
                }
                catch {
                    // Ignore close errors on the failure path.
                }
                // We created the lockfile but failed to write/close it. Remove the
                // empty/partial file so other processes are not blocked until the
                // TTL expires on a lock that was never validly held.
                try {
                    fs.unlinkSync(lockPath);
                }
                catch {
                    // Best-effort: already gone.
                }
            }
            const code = err?.code;
            if (code !== "EEXIST") {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`pm-github: comment-sync lock failed (${msg}) — proceeding without cross-process serialization`);
                return { status: "degraded" };
            }
            // The lock exists. If it vanished before we could stat it, retry at once.
            let existing;
            let mtimeMs = Number.NaN;
            try {
                mtimeMs = fs.statSync(lockPath).mtimeMs;
                existing = readImportLockPayload(lockPath);
            }
            catch {
                continue;
            }
            const staleReason = importLockStaleReason(lockPath, existing, mtimeMs, ttlMs);
            if (staleReason && staleBreaks < IMPORT_LOCK_MAX_STALE_BREAKS) {
                staleBreaks++;
                if (breakStaleImportLock(lockPath, ttlMs, staleReason))
                    continue;
                // Lost the breaker election or the lock turned out live on re-check —
                // fall through to the normal wait/backoff below.
            }
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs >= waitMs)
                return { status: "contended" };
            // Jittered backoff, mirroring the pm CLI's lock wait (0.5x–1.5x jitter).
            const jittered = Math.max(1, Math.round(backoffMs * (0.5 + Math.random())));
            await sleep(Math.min(jittered, waitMs - elapsedMs));
            backoffMs = Math.min(backoffMs * 2, IMPORT_LOCK_MAX_BACKOFF_MS);
        }
    }
}
// ---------------------------------------------------------------------------
// Native comment sync (GitHub issue comments → pm comments collection)
// ---------------------------------------------------------------------------
//
// `--comments-mode annotations|both` mirrors a GitHub issue's conversation into
// the pm item's native comments collection (the SDK `comments()` primitive), so
// agents get structured, queryable comments instead of body-embedded text.
//
// Re-sync is idempotent: every stored comment carries a stable marker embedding
// the GitHub comment id (`<!-- pm-github:comment:N -->`). On re-import the
// already-synced ids are read back and skipped, so re-running import never
// duplicates a comment.
/**
 * Matches the hidden HTML-comment marker carrying a synced GitHub comment id.
 *
 * HTML comments are invisible in rendered markdown but survive `pm comments`
 * storage verbatim, so the id embedded in the marker is the stable dedupe key.
 */
export const COMMENT_MARKER_REGEX = /<!--\s*pm-github:comment:(\d+)\s*-->/;
/**
 * Build the text for one native pm comment from a GitHub comment.
 *
 * Appends the marker so a later re-sync can de-duplicate on the GitHub comment
 * id (see {@link COMMENT_MARKER_REGEX}).
 *
 * @param comment - The GitHub comment to render.
 * @returns The comment text with the trailing id marker.
 */
export function buildCommentText(comment) {
    const body = (comment.body || "").trim() || "(empty comment)";
    return `${body}\n\n<!-- pm-github:comment:${comment.id} -->`;
}
/**
 * Collect the GitHub comment ids already synced into an item's native comments.
 *
 * Scans each stored comment's text for the stable marker. Returns the set of
 * synced ids (empty when none match, e.g. for hand-written pm comments).
 *
 * @param stored - The item's existing native comments (each may carry marker text).
 * @returns The set of already-synced GitHub comment ids.
 */
export function extractSyncedCommentIds(stored) {
    const ids = new Set();
    for (const entry of stored) {
        if (!entry?.text)
            continue;
        const m = COMMENT_MARKER_REGEX.exec(entry.text);
        if (m)
            ids.add(Number(m[1]));
    }
    return ids;
}
// Parse the newly-created item id out of `pm create --json` stdout, which is a
// FLAT envelope — `{ "id": "pm-xxxx", "status": "open", "changed_field_count": N }`
// — with no `item` wrapper.
//
// This function previously read `parsed.item.id`, a shape the CLI has never
// emitted (mutations return a flat receipt; only queries like `pm read`/`pm list`
// wrap, see upstream pm-cli#888). Because it returns undefined rather than
// throwing, the effect was invisible: every closed-issue import was left open and
// every comment sync was skipped, while unit tests that fed the fabricated
// `{item:{id}}` shape kept passing.
//
// No `item` fallback is kept. A fallback for a shape the host has never emitted
// is dead code that cannot be exercised by any real CLI, and a test asserting it
// would re-create the original failure mode: a parser and a test agreeing with
// each other rather than with the CLI. The regression test instead parses the
// output of a REAL `pm create --json` run, so the envelope cannot drift unnoticed.
//
// Returns undefined when the output genuinely cannot be parsed, so callers fall
// back to a safe skip-with-warning instead of crashing the whole import.
/**
 * Extract the newly-created item id from `pm create --json` stdout.
 *
 * The CLI emits a FLAT envelope (`{ "id": "pm-xxxx", … }`) with no `item`
 * wrapper, so this reads `parsed.id` directly. Returns `undefined` when the
 * output genuinely cannot be parsed, so callers skip-with-warning instead of
 * crashing the whole import.
 *
 * @param stdout - Raw `pm create --json` output.
 * @returns The created item id, or `undefined`.
 */
export function parseCreatedItemId(stdout) {
    try {
        const parsed = JSON.parse(stdout);
        const id = parsed?.id;
        return typeof id === "string" ? id : undefined;
    }
    catch {
        return undefined;
    }
}
// Sync GitHub issue comments into a pm item's native comments collection via
// the SDK `comments()` primitive. Idempotent: comments already present (matched
// by their GitHub comment id marker) are skipped, so re-running import never
// duplicates. Each GitHub comment becomes one pm comment authored by the
// GitHub login. Failures are logged and never abort the import.
//
// Concurrency (pm-github-503u, limitation lifted): the read-markers-then-append
// critical section is serialized across processes by a per-item lockfile (see
// acquireImportLock above), so two concurrent `pm github import` runs against
// the same workspace can no longer both observe a comment id as absent and
// append it twice. The lock is per ITEM, not per import run: unrelated issues
// in concurrent imports still sync in parallel, and only the one item whose
// comments are actively being synced is serialized — the smallest scope that
// closes the race. Stale locks (older than the TTL or owned by a dead PID) are
// broken with a stderr warning. If a live concurrent import holds the lock
// past the wait budget, this item's comment sync is skipped with a warning
// (never run unlocked, so a wedged peer can cost a sync — recoverable on the
// next import — but never cause a duplicate); if the lock mechanism itself is
// unavailable the sync proceeds unlocked as before, also with a warning.
/**
 * Sync GitHub issue comments into a pm item's native comments collection.
 *
 * Idempotent: comments already present (matched by their marker id) are skipped,
 * so re-running import never duplicates. Each GitHub comment becomes one pm
 * comment authored by the GitHub login. Failures are logged and never abort the
 * import; a contended or unavailable lock degrades gracefully (see
 * {@link acquireImportLock}).
 *
 * @param itemId - The pm item to append comments to.
 * @param comments - The GitHub comments to sync.
 * @param pmRoot - Workspace root or pm data dir.
 * @param issueNumber - The source issue number (for log prefixes).
 * @returns How many comments were added and how many skipped as duplicates.
 */
export async function syncGithubCommentsToAnnotations(itemId, comments, pmRoot, issueNumber) {
    if (comments.length === 0)
        return { added: 0, skipped: 0 };
    const acquisition = await acquireImportLock(pmRoot, itemId);
    if (acquisition.status === "contended") {
        console.error(`#${issueNumber}: comment sync for ${itemId} skipped — another import holds the ` +
            `comment-sync lock; re-run import to pick up the comments`);
        return { added: 0, skipped: 0 };
    }
    const release = acquisition.status === "acquired" ? () => acquisition.lock.release() : () => { };
    try {
        let existing = [];
        try {
            const list = await pmCommentsFn(itemId, {}, { pmRoot });
            existing = list.comments;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`#${issueNumber}: could not read existing comments for ${itemId} — ${msg}`);
            return { added: 0, skipped: 0 };
        }
        const synced = extractSyncedCommentIds(existing);
        let added = 0;
        let skipped = 0;
        for (const c of comments) {
            if (synced.has(c.id)) {
                skipped++;
                continue;
            }
            const author = c.user?.login ?? "github";
            try {
                await pmCommentsFn(itemId, { add: buildCommentText(c), author }, { pmRoot });
                added++;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`#${issueNumber}: comment ${c.id} sync failed — ${msg}`);
            }
        }
        return { added, skipped };
    }
    finally {
        release();
    }
}
/**
 * Whether a GitHub issue node is a draft pull request.
 *
 * A draft PR is an issue that is BOTH a pull request and flagged `draft: true`;
 * plain issues are never drafts.
 *
 * @param issue - The issue node to test.
 * @returns True only for draft pull requests.
 */
export function isDraftPr(issue) {
    return Boolean(issue.pull_request) && issue.draft === true;
}
/**
 * Apply the client-side import filters the REST API cannot express.
 *
 * Drops pull requests (unless `includePrs`), draft PRs (when `skipDrafts`), and
 * items whose milestone title does not match (the API keys milestones by number,
 * not title). Returns the surviving issues in input order.
 *
 * @param issues - Fetched issues to narrow.
 * @param opts - Import options carrying the filter flags.
 * @returns The filtered issue list.
 */
export function applyClientFilters(issues, opts) {
    let result = issues;
    if (!opts.includePrs)
        result = result.filter((i) => !i.pull_request);
    // --skip-drafts only takes effect alongside --include-prs (without it, all
    // PRs — drafts included — are already filtered out above).
    if (opts.skipDrafts)
        result = result.filter((i) => !isDraftPr(i));
    if (opts.milestone) {
        result = result.filter((i) => i.milestone?.title === opts.milestone);
    }
    return result;
}
/**
 * Normalize the raw CLI flag bag into a typed {@link ImportOptions}.
 *
 * Resolves the state filter, labels, assignee, milestone, the `--since` window,
 * PR inclusion, draft skipping, and the comment-fetching mode, throwing a
 * {@link CommandError} with a usage code on a malformed `--since` or
 * `--comments-mode`.
 *
 * @param options - The raw option object from the command handler.
 * @returns The normalized import options.
 */
export function parseImportOptions(options) {
    // --state takes precedence; --all is the legacy shorthand for "all".
    const stateOpt = optionString(options, "state");
    const includeAll = optionEnabled(options, "all");
    const state = stateOpt && ["open", "closed", "all"].includes(stateOpt)
        ? stateOpt
        : includeAll
            ? "all"
            : "open";
    const sinceInput = optionString(options, "since");
    const since = parseSince(sinceInput);
    if (optionProvided(options, "since") && !since) {
        throw new CommandError("--since must be an ISO 8601 timestamp or a positive relative duration such as 30m, 12h, 7d, or 1w.", EXIT_CODE.USAGE);
    }
    // --comments-mode controls how fetched GitHub comments are persisted.
    // Default "body" preserves the historical blockquoted-body behavior exactly.
    const commentsModeInput = optionString(options, "comments-mode", "commentsMode");
    if (commentsModeInput && !COMMENTS_MODES.includes(commentsModeInput)) {
        throw new CommandError(`--comments-mode must be one of: ${COMMENTS_MODES.join(", ")} (got ${commentsModeInput})`, EXIT_CODE.USAGE);
    }
    // Resolve --with-comments first so commentsMode can reconcile against it.
    const withCommentsResolved = optionEnabled(options, "with-comments", "withComments", "include-comments", "includeComments");
    let commentsMode = commentsModeInput || "body";
    // Reconcile with the legacy --with-comments flag. --with-comments historically
    // means "fetch + embed in body". When the user also asks for annotations, the
    // intuitive combined intent is BOTH body and native comments (not silently
    // dropping --with-comments), so upgrade annotations → both. body/both are
    // already consistent with --with-comments and need no adjustment.
    if (withCommentsResolved && commentsMode === "annotations") {
        commentsMode = "both";
    }
    return {
        state,
        labels: optionString(options, "labels"),
        since,
        assignee: optionString(options, "assignee"),
        milestone: optionString(options, "milestone"),
        includePrs: optionEnabled(options, "include-prs", "includePrs"),
        skipDrafts: optionEnabled(options, "skip-drafts", "skipDrafts"),
        withComments: withCommentsResolved,
        commentsMode,
        itemType: optionString(options, "type") || "Issue",
        dryRun: optionEnabled(options, "dry-run", "dryRun"),
        atomic: optionEnabled(options, "atomic"),
        linkDeps: optionEnabled(options, "link-deps", "linkDeps"),
    };
}
// Spawn the `pm` CLI with the given argv and return a normalized ok/stdout/stderr
// result (ok = exit code 0). Centralizes every pm mutation so callers share one
// error-handling shape.
function pmRun(args) {
    const maxBuffer = pmJsonMaxBuffer();
    const result = spawnSync("pm", args, { encoding: "utf-8", maxBuffer });
    return { ok: result.status === 0, stderr: result.stderr || "", stdout: result.stdout || "" };
}
// Strip fenced (```…```) and inline (`…`) code so `#123` mentions inside code
// samples never masquerade as declared dependencies.
function stripCodeSpans(body) {
    return body
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]*`/g, " ");
}
// A dependency phrase at a word boundary, plus trailing separator. Global +
// case-insensitive; each match anchors where the reference run begins.
const DEP_PHRASE_RE = /\b(blocked[\s-]?by|depends[\s-]?on|blocks)\b[\s:]*/gi;
// One `owner/repo#N` or bare `#N` reference, matched STICKILY (`y`) so it only
// succeeds at the exact scan position — no scanning ahead, no backtracking.
const DEP_REF_STICKY = /(?:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+))?#(\d+)/y;
// Comma/whitespace glue with an optional "and" between consecutive refs
// ("#1, #2 and #3"). Sticky and can match empty, so the ref loop always
// terminates: the next sticky ref match is what decides whether to continue.
const DEP_GLUE_STICKY = /[\s,]*(?:and\b[\s,]*)?/y;
/**
 * Map a dependency phrase captured from an issue body to its pm edge kind.
 *
 * Collapses spacing/hyphen variants and returns both the canonical
 * {@link DepRefKind} and a normalized human phrase ("blocks", "depends on", or
 * "blocked by") for audit messages.
 *
 * @param raw - The raw phrase matched by the dependency-phrase regex.
 * @returns The resolved kind and normalized phrase.
 */
function phraseToKind(raw) {
    const compact = raw.toLowerCase().replace(/[\s-]/g, "");
    if (compact === "blocks")
        return { kind: "blocks", phrase: "blocks" };
    if (compact === "dependson")
        return { kind: "blocked_by", phrase: "depends on" };
    return { kind: "blocked_by", phrase: "blocked by" };
}
/**
 * Parse dependency references from one issue body. Pure. Bare `#N` refs resolve
 * against `sourceRepo` (lowercased); `owner/repo#N` refs keep their explicit
 * repo (lowercased). References are de-duplicated within the body by
 * repo+number+kind so a body repeating a link yields one ref.
 *
 * Scanning is linear: each dependency phrase is found once, then references are
 * consumed one at a time with sticky (`y`) regexes anchored at the exact scan
 * position. There is no nested quantifier or look-ahead over unbounded input,
 * so the parser cannot backtrack catastrophically on adversarial bodies.
 */
export function parseDependencyReferences(body, sourceRepo) {
    if (!body)
        return [];
    const text = stripCodeSpans(body);
    const repoLc = sourceRepo.toLowerCase();
    const out = [];
    const seen = new Set();
    for (const m of text.matchAll(DEP_PHRASE_RE)) {
        const { kind, phrase } = phraseToKind(m[1]);
        let pos = m.index + m[0].length;
        // Consume the run of references immediately following the phrase.
        for (;;) {
            DEP_REF_STICKY.lastIndex = pos;
            const ref = DEP_REF_STICKY.exec(text);
            if (!ref)
                break;
            const repo = (ref[1] ? ref[1] : repoLc).toLowerCase();
            const number = Number.parseInt(ref[2], 10);
            if (Number.isSafeInteger(number) && number > 0) {
                const key = `${repo}#${number}|${kind}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push({ repo, number, kind, phrase });
                }
            }
            pos = DEP_REF_STICKY.lastIndex;
            // Skip separator glue; if no further ref follows, the next iteration's
            // sticky match fails at `pos` and the run ends.
            DEP_GLUE_STICKY.lastIndex = pos;
            DEP_GLUE_STICKY.exec(text);
            pos = DEP_GLUE_STICKY.lastIndex;
        }
    }
    return out;
}
/** Build a `repo#number` → pm item id index from an item-metadata snapshot. */
export function buildProvenanceIndexFromMetadata(items) {
    const index = new Map();
    for (const item of items) {
        if (!item.id)
            continue;
        for (const tag of item.tags ?? []) {
            const p = parseProvenanceTag(tag);
            // First writer wins: a provenance tag is a 1:1 issue↔item link, and the
            // import guarantees uniqueness; guarding keeps a hand-edited duplicate
            // deterministic rather than order-dependent.
            if (p && !index.has(`${p.repo}#${p.number}`)) {
                index.set(`${p.repo}#${p.number}`, item.id);
            }
        }
    }
    return index;
}
/**
 * Resolve parsed references into concrete workspace edges. Skips references
 * whose source or target issue is not present in the workspace (counted as
 * `unresolved`), self-references, and duplicates. Pure.
 */
export function planDependencyLinks(repo, issues, provenance) {
    const repoLc = repo.toLowerCase();
    const edges = [];
    const seen = new Set();
    let unresolved = 0;
    for (const issue of issues) {
        const sourceKey = `${repoLc}#${issue.number}`;
        const sourceId = provenance.get(sourceKey);
        // Source not in the workspace (e.g. its own import was skipped): its edges
        // have nowhere to attach; leave them for a later re-run rather than count
        // them as unresolved targets.
        if (!sourceId)
            continue;
        for (const ref of parseDependencyReferences(issue.body ?? "", repoLc)) {
            const targetKey = `${ref.repo}#${ref.number}`;
            if (targetKey === sourceKey)
                continue; // self-reference by provenance
            const targetId = provenance.get(targetKey);
            if (!targetId) {
                unresolved++;
                continue;
            }
            if (targetId === sourceId)
                continue; // self-reference by resolved id
            const dedupeKey = `${sourceId}|${targetId}|${ref.kind}`;
            if (seen.has(dedupeKey))
                continue;
            seen.add(dedupeKey);
            edges.push({ sourceId, targetId, kind: ref.kind, sourceIssue: issue.number, phrase: ref.phrase });
        }
    }
    return { edges, unresolved };
}
/** Count candidate references across issues without resolving them (dry-run preview). */
export function countDependencyRefCandidates(repo, issues) {
    const repoLc = repo.toLowerCase();
    let n = 0;
    for (const issue of issues)
        n += parseDependencyReferences(issue.body ?? "", repoLc).length;
    return n;
}
/**
 * Build the default SDK-backed dependency-link collaborators.
 *
 * Wires the `--link-deps` second pass to the top-level SDK imports so it never
 * needs a dynamic import. `listAllItemMetadata` returns full `ItemMetadata`
 * objects, projected here to the {@link DepLinkSnapshotItem} structural subset
 * the link pass reads; the SDK cycle detector reads only id/tags/dependencies,
 * so the cast on `collectNewOrderingCycleWarnings` is sound.
 *
 * @returns The default SDK collaborators.
 */
function defaultDepLinkSdk() {
    return {
        listAllItemMetadata: async (pmRoot) => {
            const raw = await sdkListAllItemMetadata(pmRoot);
            return raw.map((i) => ({
                id: i.id,
                tags: i.tags,
                dependencies: i.dependencies,
            }));
        },
        collectNewOrderingCycleWarnings: sdkCollectNewOrderingCycleWarnings,
    };
}
/**
 * Default edge applier: spawn `pm update --dep` for one resolved edge.
 *
 * Records the source issue and the matching phrase in the mutation message so
 * the resulting dependency is auditable. Returns the ok/stderr shape every edge
 * applier shares, never throwing.
 *
 * @param edge - The resolved workspace edge to write.
 * @param pmRoot - Workspace root for the `pm` invocation.
 * @returns Whether the write succeeded and any stderr.
 */
function defaultApplyDependencyLink(edge, pmRoot) {
    const res = pmRun([
        "--path", pmRoot, "update", edge.sourceId,
        "--dep", `id=${edge.targetId},kind=${edge.kind}`,
        "--message", `Linked from GitHub #${edge.sourceIssue} body ("${edge.phrase}" reference)`,
    ]);
    return { ok: res.ok, stderr: res.stderr };
}
/**
 * The `--link-deps` second pass. Snapshots the workspace, resolves body
 * references to edges, applies them idempotently, then re-snapshots and asks the
 * SDK which ordering cycles the batch newly introduced. Never throws for an
 * individual edge; a resolution/SDK failure surfaces through the returned
 * `failures`/warnings so the import result stays truthful.
 */
export async function linkImportedDependencies(repo, issues, pmRoot, deps = {}) {
    const applyEdge = deps.applyDependencyLink ?? defaultApplyDependencyLink;
    const failures = [];
    // Resolve the SDK-backed helpers and take the pre-edge snapshot. This runs
    // AFTER the import has already committed, so a failure here (a host whose CLI
    // predates the required SDK exports, or an unreadable workspace) must never
    // reject and discard the successful import result — degrade to a reported
    // failure and skip linking, honoring the "a failure never fails the import"
    // contract for infra errors, not just per-edge errors.
    let listMeta;
    let collect;
    let before;
    try {
        const needsSdk = !deps.listItemMetadata || !deps.collectOrderingCycleWarnings;
        const sdk = needsSdk ? defaultDepLinkSdk() : undefined;
        listMeta = deps.listItemMetadata ?? ((r) => sdk.listAllItemMetadata(r));
        collect = deps.collectOrderingCycleWarnings ?? sdk.collectNewOrderingCycleWarnings;
        before = await listMeta(pmRoot);
    }
    catch (err) {
        return {
            linked: 0,
            unresolved: 0,
            orderingCycleWarnings: [],
            failures: [`dependency linking skipped: ${err instanceof Error ? err.message : String(err)}`],
        };
    }
    const provenance = buildProvenanceIndexFromMetadata(before);
    const { edges, unresolved } = planDependencyLinks(repo, issues, provenance);
    if (edges.length === 0) {
        return { linked: 0, unresolved, orderingCycleWarnings: [], failures };
    }
    const changedSources = new Set();
    let linked = 0;
    for (const edge of edges) {
        const res = applyEdge(edge, pmRoot);
        if (res.ok) {
            linked++;
            changedSources.add(edge.sourceId);
        }
        else {
            failures.push(`#${edge.sourceIssue} ${edge.sourceId} —(${edge.kind})→ ${edge.targetId}: ${res.stderr.trim()}`);
        }
    }
    // The ordering-cycle advisory is likewise best-effort: a re-snapshot or
    // detector failure must not discard the edges already written, so it degrades
    // to a reported note rather than throwing.
    const warnings = new Set();
    if (changedSources.size > 0) {
        try {
            const after = await listMeta(pmRoot);
            for (const id of changedSources) {
                for (const w of collect(before, after, id))
                    warnings.add(w);
            }
        }
        catch (err) {
            failures.push(`ordering-cycle advisory skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { linked, unresolved, orderingCycleWarnings: [...warnings], failures };
}
/**
 * Render one GitHub issue into the import-ready desired state.
 *
 * Computes the title, status, provenance/author tags, description, body (with
 * optional embedded comments), and the comment list for native sync. Returns
 * `undefined` for an issue with no usable title so the caller counts it skipped.
 *
 * @param issue - The fetched issue to render.
 * @param repo - `owner/repo`, baked into the provenance tag.
 * @param opts - Import options governing body/comments.
 * @param token - GitHub token for the comment fetch.
 * @param match - The existing pm item linked to this issue, if any (drives update vs create).
 * @param fetchIssueComments - Injectable comment fetcher (defaults to {@link fetchComments}).
 * @returns The prepared import entry, or `undefined` when the issue has no title.
 */
async function prepareGithubImport(issue, repo, opts, token, match, fetchIssueComments = fetchComments) {
    const title = issue.title.trim();
    if (!title)
        return undefined;
    const kind = issue.pull_request ? "PR" : "issue";
    const labels = issue.labels.map((label) => label.name).filter(Boolean);
    const tag = provenanceTag(repo, issue.number);
    const ghAuthorTag = authorTag(issue);
    const author = issue.user?.login;
    const syncAnnotations = opts.commentsMode === "annotations" || opts.commentsMode === "both";
    const shouldFetchComments = opts.withComments || syncAnnotations;
    const writeCommentsToBody = opts.commentsMode === "body" || opts.commentsMode === "both";
    let comments = [];
    if (shouldFetchComments) {
        try {
            comments = await fetchIssueComments(issue, repo, token);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`#${issue.number}: failed to fetch comments — ${msg}`);
        }
    }
    return {
        issueNumber: issue.number,
        title,
        itemType: opts.itemType,
        status: mapState(issue.state, issue.state_reason),
        description: `GH ${kind} #${issue.number}: ${issue.html_url}` +
            (author ? ` · author @${author}` : "") +
            (issue.state_reason ? ` · state reason ${issue.state_reason}` : "") +
            (issue.created_at ? ` · created ${issue.created_at}` : "") +
            (issue.updated_at ? ` · updated ${issue.updated_at}` : ""),
        body: writeCommentsToBody ? composeBody(issue, comments) : (issue.body || ""),
        tags: [...labels, tag, ...(ghAuthorTag ? [ghAuthorTag] : [])],
        assignee: issue.assignee?.login,
        milestone: issue.milestone?.title,
        comments,
        syncAnnotations,
        closedAt: issue.closed_at ?? undefined,
        match,
    };
}
/**
 * Run the full GitHub issue import flow.
 *
 * Idempotent: items already linked (by provenance tag) to a fetched issue are
 * UPDATEd; new issues are created. Honors `--atomic` (one crash-resumable
 * transaction) versus the per-item `pm` mutation path, optional `--link-deps`,
 * and `--dry-run`. Returns a structured result and throws {@link CommandError}
 * (with a semantic exit code) on failure.
 *
 * @param repoArg - The `owner/repo` to import from.
 * @param pmRoot - Workspace root or pm data dir.
 * @param opts - Normalized import options.
 * @param deps - Injectable collaborators (token resolver, fetchers, etc.) for tests.
 */
export async function runImport(repoArg, pmRoot, opts, dependencies = {}) {
    if (!repoArg || !repoArg.includes("/")) {
        throw new CommandError("Usage: pm github import <owner/repo> [--all|--state open|closed|all] " +
            "[--labels bug,enhancement] [--since <iso>] [--assignee <login>] " +
            "[--milestone <name>] [--include-prs] [--skip-drafts] [--with-comments] " +
            "[--comments-mode body|annotations|both] [--atomic]", EXIT_CODE.USAGE);
    }
    const repo = repoArg;
    const token = (dependencies.resolveToken ?? resolveGitHubToken)();
    console.error(`Fetching issues from ${repo}…${token ? "" : " (unauthenticated — 60 req/hr)"}`);
    let fetched;
    try {
        fetched = await (dependencies.fetchIssues ?? fetchAllIssues)(repo, opts, token);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hint = !token && /HTTP 403/.test(msg)
            ? " — set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` to raise the rate limit (60→5000/hr) and reach private repos"
            : "";
        const exitCode = /HTTP 404/.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
        throw new CommandError(`Failed to fetch issues from ${repo}: ${msg}${hint}`, exitCode);
    }
    const filtered = applyClientFilters(fetched, opts);
    if (filtered.length === 0) {
        console.error("No issues found.");
        if (opts.atomic && opts.dryRun) {
            return {
                dryRun: true,
                wouldImport: 0,
                wouldUpdate: 0,
                wouldSkip: 0,
                atomic: true,
            };
        }
        return { imported: 0, updated: 0, skipped: 0 };
    }
    console.error(`Found ${filtered.length} issue(s).`);
    // Build the idempotency index once up-front — including for a dry run. Skipping
    // it on a non-atomic dry run made every issue look like a create, so the preview
    // reported "would import N, skip 0" where the real run performs updates for
    // already-linked issues. A preview that overstates creates reads as "this will
    // duplicate my whole tracker" and is the one thing --dry-run exists to rule out.
    const existing = indexByProvenance((dependencies.readItems ?? readPmItems)(pmRoot));
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    if (opts.atomic) {
        const prepared = [];
        for (const issue of filtered) {
            const entry = await prepareGithubImport(issue, repo, opts, token, existing.get(`${repo.toLowerCase()}#${issue.number}`), dependencies.fetchIssueComments);
            if (!entry) {
                skipped++;
                continue;
            }
            prepared.push(entry);
        }
        if (prepared.length === 0) {
            if (opts.dryRun) {
                console.error(`[dry-run] Atomic plan would import 0, update 0, skip ${skipped}.`);
                return {
                    dryRun: true,
                    wouldImport: 0,
                    wouldUpdate: 0,
                    wouldSkip: skipped,
                    atomic: true,
                };
            }
            throw new CommandError(`Imported 0 issue(s); ${skipped} failed.`, EXIT_CODE.GENERIC_FAILURE);
        }
        if (opts.dryRun) {
            imported = prepared.filter((entry) => !entry.match?.id).length;
            updated = prepared.length - imported;
            for (const entry of prepared) {
                const action = entry.match?.id ? "update" : "import";
                console.error(`  [dry-run][atomic] #${entry.issueNumber} ${action}: ${entry.title} (${entry.status})`);
            }
            console.error(`[dry-run] Atomic plan would import ${imported}, update ${updated}, skip ${skipped}.`);
            if (opts.linkDeps) {
                console.error(`[dry-run] --link-deps: ${countDependencyRefCandidates(repo, filtered)} candidate reference(s) parsed; ` +
                    `resolution + edge writes run only on a real import.`);
            }
            return {
                dryRun: true,
                wouldImport: imported,
                wouldUpdate: updated,
                wouldSkip: skipped,
                atomic: true,
                ...(opts.linkDeps ? { wouldLinkDependencyCandidates: countDependencyRefCandidates(repo, filtered) } : {}),
            };
        }
        const result = await (dependencies.commitAtomic ?? importGithubAtomic)(pmRoot, repo, prepared);
        for (const entry of prepared) {
            if (!entry.syncAnnotations)
                continue;
            const itemId = result.itemIds.get(entry.issueNumber);
            if (itemId) {
                await syncGithubCommentsToAnnotations(itemId, entry.comments, pmRoot, entry.issueNumber);
            }
        }
        if (result.recovered) {
            console.error(`Atomic import recovered transaction ${result.transactionId} covering ${result.recoveredItems ?? prepared.length} item(s).`);
        }
        else {
            console.error(`Atomically imported ${result.imported} new, updated ${result.updated} existing, skipped ${skipped}.`);
        }
        const atomicDepLink = opts.linkDeps
            ? await linkImportedDependencies(repo, filtered, pmRoot, dependencies)
            : undefined;
        reportDepLink(atomicDepLink);
        // itemIds is an internal post-commit routing map for native comments. Maps
        // serialize as `{}` in JSON, so keep it out of the public command result.
        return {
            transactionId: result.transactionId,
            recovered: result.recovered,
            imported: result.imported,
            updated: result.updated,
            ...(result.recoveredItems !== undefined ? { recoveredItems: result.recoveredItems } : {}),
            skipped,
            atomic: true,
            ...depLinkResultFields(atomicDepLink),
        };
    }
    for (const issue of filtered) {
        const prepared = await prepareGithubImport(issue, repo, opts, token, existing.get(`${repo.toLowerCase()}#${issue.number}`), dependencies.fetchIssueComments);
        if (!prepared) {
            skipped++;
            continue;
        }
        const labels = issue.labels.map((l) => l.name).filter(Boolean);
        const { title, status, assignee, milestone, match, description, body, tags, comments, syncAnnotations, closedAt, } = prepared;
        /**
         * Build the `pm close` argv for this issue's pm item.
         *
         * Two paths below close an item for the same reason — reconciling an
         * already-matched item whose upstream issue is now closed, and closing an
         * item that was just created `open` because pm-cli 2026.8.3 refuses a
         * terminal `create --status closed`. Both must carry identical provenance
         * (the reason) and identical completion evidence (GitHub's own `closed_at`,
         * when it recorded one), so the argv is built once here rather than
         * duplicated at each site where the two could silently drift apart.
         */
        const githubCloseArgs = (id) => {
            const args = ["--path", pmRoot, "close", id, "--reason", `GitHub issue #${issue.number} closed`];
            if (closedAt)
                args.push("--completed-at", closedAt);
            return args;
        };
        if (opts.dryRun) {
            const action = match?.id ? "update" : "import";
            const metadata = labels.length > 0 ? `${status}, ${labels.join(",")}` : status;
            console.error(`  [dry-run] #${issue.number} ${action}: ${title} (${metadata})`);
            if (match?.id)
                updated++;
            else
                imported++;
            continue;
        }
        if (match?.id) {
            // Idempotent update — never duplicate. Status transitions go through the
            // proper command (close requires a reason; reopen via update --status).
            const updArgs = [
                "--path", pmRoot, "update", match.id,
                "--title", title,
                "--description", description,
                "--body", body,
                "--tags", tags.join(","),
                "--message", `Re-imported from GitHub #${issue.number}`,
            ];
            if (assignee)
                updArgs.push("--assignee", assignee);
            if (milestone)
                updArgs.push("--sprint", milestone);
            const upd = pmRun(updArgs);
            if (!upd.ok) {
                console.error(`#${issue.number}: update failed — ${upd.stderr}`);
                skipped++;
                continue;
            }
            // Reconcile status separately.
            if (status === "closed" && match.status !== "closed") {
                // Close through `pm close` so the reason is real provenance; pass the
                // source completion time as --completed-at when GitHub recorded one.
                const close = pmRun(githubCloseArgs(match.id));
                if (!close.ok) {
                    console.error(`#${issue.number}: close reconciliation failed — ${close.stderr}`);
                    skipped++;
                    continue;
                }
            }
            else if (status === "open" && match.status === "closed") {
                const reopen = pmRun(["--path", pmRoot, "update", match.id, "--status", "open", "--message", `GitHub issue #${issue.number} reopened`]);
                if (!reopen.ok) {
                    console.error(`#${issue.number}: reopen reconciliation failed — ${reopen.stderr}`);
                    skipped++;
                    continue;
                }
            }
            if (syncAnnotations) {
                await syncGithubCommentsToAnnotations(match.id, comments, pmRoot, issue.number);
            }
            updated++;
            continue;
        }
        // A closed upstream issue cannot be born closed: governance
        // `require_close_reason` rejects `pm create --status closed`. Create the
        // item open, then close it through `pm close` with the source's real
        // completion timestamp (`closed_at`) as --completed-at provenance.
        const createStatus = status === "closed" ? "open" : status;
        const mustClose = status === "closed";
        const createArgs = [
            "--path", pmRoot, "create",
            "--title", title,
            "--type", opts.itemType,
            "--status", createStatus,
            "--description", description,
            "--body", body,
            "--tags", tags.join(","),
            "--message", `Imported from GitHub #${issue.number}`,
        ];
        if (assignee)
            createArgs.push("--assignee", assignee);
        if (milestone)
            createArgs.push("--sprint", milestone);
        // --json lets a following close (or annotations sync) address the freshly
        // created item by id without re-scanning the workspace.
        if (mustClose || syncAnnotations)
            createArgs.push("--json");
        const created = pmRun(createArgs);
        if (!created.ok) {
            console.error(`#${issue.number}: create failed — ${created.stderr}`);
            skipped++;
            continue;
        }
        const createdId = (mustClose || syncAnnotations) ? parseCreatedItemId(created.stdout) : undefined;
        if (mustClose) {
            if (createdId) {
                const close = pmRun(githubCloseArgs(createdId));
                if (!close.ok) {
                    console.error(`#${issue.number}: close after import failed — ${close.stderr}`);
                    skipped++;
                    continue;
                }
            }
            else {
                // The item exists but is still open, and without its id nothing here can
                // close it. Counting it as imported would report a closed GitHub issue as
                // a successfully imported *open* item, so it is reported as skipped —
                // the same accounting the close-failure branch above already uses.
                console.error(`#${issue.number}: could not parse created item id — left open`);
                skipped++;
                continue;
            }
        }
        if (syncAnnotations) {
            if (createdId) {
                await syncGithubCommentsToAnnotations(createdId, comments, pmRoot, issue.number);
            }
            else {
                console.error(`#${issue.number}: could not parse created item id — comments not synced`);
            }
        }
        imported++;
    }
    if (opts.dryRun) {
        console.error(`[dry-run] Would import ${imported}, update ${updated}, skip ${skipped}.`);
        if (opts.linkDeps) {
            console.error(`[dry-run] --link-deps: ${countDependencyRefCandidates(repo, filtered)} candidate reference(s) parsed; ` +
                `resolution + edge writes run only on a real import.`);
        }
        return {
            dryRun: true,
            wouldImport: imported,
            wouldUpdate: updated,
            wouldSkip: skipped,
            ...(opts.atomic ? { atomic: true } : {}),
            ...(opts.linkDeps ? { wouldLinkDependencyCandidates: countDependencyRefCandidates(repo, filtered) } : {}),
        };
    }
    console.error(`Imported ${imported} new, updated ${updated} existing, skipped ${skipped}.`);
    if (imported === 0 && updated === 0 && skipped > 0) {
        throw new CommandError(`Imported 0 issue(s); ${skipped} failed.`);
    }
    const depLink = opts.linkDeps
        ? await linkImportedDependencies(repo, filtered, pmRoot, dependencies)
        : undefined;
    reportDepLink(depLink);
    return { imported, updated, skipped, ...depLinkResultFields(depLink) };
}
/**
 * Emit the human-readable `--link-deps` summary to stderr.
 *
 * Import progress is written to stderr so stdout stays reserved for the
 * structured result; this prints the linked-edge count, unresolved refs, and
 * any ordering-cycle warnings or per-edge failures.
 */
function reportDepLink(result) {
    if (!result)
        return;
    const parts = [`linked ${result.linked} dependency edge(s)`];
    if (result.unresolved > 0)
        parts.push(`${result.unresolved} unresolved ref(s)`);
    console.error(`--link-deps: ${parts.join(", ")}.`);
    for (const warning of result.orderingCycleWarnings)
        console.error(`  ⚠ ${warning}`);
    for (const failure of result.failures)
        console.error(`  ✗ link failed: ${failure}`);
}
/**
 * The public, JSON-serializable slice of a `--link-deps` result.
 *
 * Kept flat and omitted entirely when the pass did not run, so the default
 * import result is unchanged.
 */
function depLinkResultFields(result) {
    if (!result)
        return {};
    return {
        linkedDependencies: result.linked,
        unresolvedDependencyRefs: result.unresolved,
        orderingCycleWarnings: result.orderingCycleWarnings,
        ...(result.failures.length > 0 ? { dependencyLinkFailures: result.failures } : {}),
    };
}
// ---------------------------------------------------------------------------
// Sync core — push pm status changes back to GitHub (close / reopen)
// ---------------------------------------------------------------------------
function pmStatusToGithubState(status) {
    return status === "closed" || status === "canceled" ? "closed" : "open";
}
// Build the pm → GitHub issue sync plan: for each pm item linked to `repo`, emit
// a create-or-update entry keyed by the issue's provenance tag.
export function planSync(items, repo) {
    const plan = [];
    const repoLc = repo.toLowerCase();
    for (const item of items) {
        if (!item.id)
            continue;
        for (const tag of item.tags ?? []) {
            const p = parseProvenanceTag(tag);
            if (!p || p.repo !== repoLc)
                continue;
            const desired = pmStatusToGithubState(item.status);
            plan.push({
                id: item.id,
                number: p.number,
                title: item.title ?? "(untitled)",
                // `from` is unknown without a fetch; the planner records desired state
                // and the executor only PATCHes when GitHub disagrees.
                from: desired === "open" ? "closed" : "open",
                to: desired,
            });
        }
    }
    return plan;
}
// Command handler for `pm github sync`: preview or apply the pm → GitHub issue
// sync plan, scoped by --ids and honoring --dry-run / --apply.
async function runSync(ctx) {
    const options = ctx.options || {};
    const repo = optionString(options, "repo") || ctx.args?.[0];
    const dryRun = optionEnabled(options, "dry-run", "dryRun");
    const idsProvided = optionProvided(options, "ids");
    const scopedIds = optionCsv(options, "ids");
    if (!repo || !repo.includes("/")) {
        throw new CommandError("Usage: pm github sync --repo <owner/repo> [--dry-run]  " +
            "(pushes pm item status to the linked GitHub issue: close/reopen)", EXIT_CODE.USAGE);
    }
    if (idsProvided && scopedIds.length === 0) {
        throw new CommandError("--ids requires at least one pm item id (comma-separated), e.g. --ids pm-123,pm-456.", EXIT_CODE.USAGE);
    }
    const token = resolveGitHubToken();
    if (!token && !dryRun) {
        throw new CommandError("pm github sync needs a GitHub token to mutate issues " +
            "(set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`). Use --dry-run to preview without a token.", EXIT_CODE.USAGE);
    }
    const allItems = readPmItems(ctx.pm_root);
    const scoped = scopeItemsByIds(allItems, scopedIds.length > 0 ? scopedIds : undefined);
    if (scoped.missing.length > 0) {
        throw new CommandError(`--ids included unknown pm item id(s): ${scoped.missing.join(", ")}`, EXIT_CODE.NOT_FOUND);
    }
    const plan = planSync(scoped.selected, repo);
    if (plan.length === 0) {
        const scopeNote = scopedIds.length > 0 ? ` from --ids (${scopedIds.join(", ")})` : "";
        console.error(`No pm items${scopeNote} linked to ${repo} ` +
            `(no \`gh:${repo.toLowerCase()}#N\` provenance tags).`);
        return {
            synced: 0,
            skipped: 0,
            planned: 0,
            ...(scopedIds.length > 0 ? { scoped_ids: scopedIds } : {}),
        };
    }
    let synced = 0;
    let skipped = 0;
    for (const entry of plan) {
        // Fetch current state so we only PATCH on a genuine divergence.
        let current;
        try {
            const { body } = await fetchJSON(`${githubApiBase()}/repos/${repo}/issues/${entry.number}`, token);
            current = JSON.parse(body);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`#${entry.number}: could not read upstream state — ${msg}`);
            skipped++;
            continue;
        }
        if (current.state === entry.to) {
            skipped++;
            continue;
        }
        if (dryRun) {
            console.error(`  [dry-run] #${entry.number} "${entry.title}": ${current.state} → ${entry.to}`);
            synced++;
            continue;
        }
        try {
            await request("PATCH", `${githubApiBase()}/repos/${repo}/issues/${entry.number}`, token, JSON.stringify({ state: entry.to }));
            console.error(`#${entry.number} "${entry.title}": ${current.state} → ${entry.to}`);
            synced++;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`#${entry.number}: PATCH failed — ${msg}`);
            skipped++;
        }
    }
    if (dryRun) {
        console.error(`[dry-run] Would update ${synced} issue(s) on ${repo}; ${skipped} already in sync/failed.`);
        return {
            dryRun: true,
            wouldSync: synced,
            skipped,
            planned: plan.length,
            ...(scopedIds.length > 0 ? { scoped_ids: scopedIds } : {}),
        };
    }
    console.error(`Synced ${synced} issue(s) on ${repo}; skipped ${skipped}.`);
    return { synced, skipped, planned: plan.length, ...(scopedIds.length > 0 ? { scoped_ids: scopedIds } : {}) };
}
// Convert a pm item into the GitHub issue create/update payload, dropping
// internal provenance tags from labels and applying the optional label map.
function itemToGithubPayload(item, labelMap) {
    // Drop our internal provenance tags from exported labels, then apply any
    // user-supplied label mapping (pm tag → GitHub label). Both issue provenance
    // (`gh:owner/repo#N`) and project provenance (`gh-project:owner/number#itemId`)
    // are stripped, but only via strict anchored matching — user labels that
    // merely contain similar text (e.g. `gh-project-notes`) are preserved.
    const labels = (item.tags ?? []).filter((t) => !parseProvenanceTag(t) && !parseProjectItemTag(t));
    return {
        title: item.title ?? "(untitled)",
        body: item.body || item.description || "",
        labels: applyLabelMap(labels, labelMap),
        state: item.status === "closed" || item.status === "canceled" ? "closed" : "open",
    };
}
// Build the create/update plan. `repo` (lowercased) decides which provenance
// tags count as an "already exported to THIS repo" link → update; everything
// else is a create. Pure + side-effect free so it can be unit-tested and
// printed verbatim in --dry-run.
export function buildExportPlan(items, repo, labelMap) {
    const repoLc = repo?.toLowerCase();
    const plan = [];
    for (const item of items) {
        const payload = itemToGithubPayload(item, labelMap);
        let number;
        if (repoLc) {
            for (const tag of item.tags ?? []) {
                const p = parseProvenanceTag(tag);
                if (p && p.repo === repoLc) {
                    number = p.number;
                    break;
                }
            }
        }
        plan.push({
            id: item.id,
            action: number === undefined ? "create" : "update",
            ...(number === undefined ? {} : { number }),
            payload,
        });
    }
    return plan;
}
// Export is SAFE BY DEFAULT: it only performs real GitHub writes when the user
// explicitly opts in (--apply / --no-dry-run, or the legacy --push alias) AND
// has not also passed --dry-run (which always wins). Anything else is a
// preview that prints the plan without touching GitHub.
export function exportWillApply(options) {
    if (optionEnabled(options, "dry-run", "dryRun"))
        return false;
    if (optionEnabled(options, "no-dry-run", "noDryRun"))
        return true;
    return optionEnabled(options, "apply", "push");
}
/**
 * Apply an already-built export plan to GitHub, one issue at a time.
 *
 * Each create/update is isolated: a single failed write (e.g. a 422 for a label
 * that does not exist on the repo) is recorded and the loop CONTINUES with the
 * remaining items — it never abandons the rest of the batch. Pure aside from the
 * injected `requestFn`, so the per-item isolation is directly unit-testable
 * without real network I/O.
 */
export async function applyExportPlan(plan, repo, token, requestFn) {
    let created = 0;
    let updated = 0;
    const failures = [];
    for (const entry of plan) {
        const p = entry.payload;
        try {
            // An "update" entry must carry the issue number; without it we must NOT
            // silently fall through to a POST (that would create a duplicate issue).
            // Record it as a per-item failure and continue.
            if (entry.action === "update" && entry.number === undefined) {
                throw new Error("update entry is missing its GitHub issue number");
            }
            if (entry.action === "update" && entry.number !== undefined) {
                await requestFn("PATCH", `${githubApiBase()}/repos/${repo}/issues/${entry.number}`, token, JSON.stringify({ title: p.title, body: p.body, labels: p.labels, state: p.state }));
                updated++;
            }
            else {
                await requestFn("POST", `${githubApiBase()}/repos/${repo}/issues`, token, JSON.stringify({ title: p.title, body: p.body, labels: p.labels }));
                created++;
            }
        }
        catch (err) {
            // Isolate the failure: record it and keep going so one bad item never
            // abandons the items that follow it (and that may already be writable).
            const msg = err instanceof Error ? err.message : String(err);
            const label = entry.action === "update" && entry.number !== undefined
                ? `#${entry.number}`
                : entry.id ?? `"${p.title}"`;
            console.error(`${label}: ${entry.action} failed — ${msg}`);
            failures.push({
                id: entry.id,
                action: entry.action,
                ...(entry.number === undefined ? {} : { number: entry.number }),
                title: p.title,
                error: msg,
            });
        }
    }
    return { created, updated, failed: failures.length, failures };
}
// Decide the EXIT STATUS of a completed `export --apply` batch.
//
// The per-item-continue design above is intentional: one bad item never aborts
// the batch. But the batch as a WHOLE still has to report honest success or
// failure to the shell. A non-empty plan that wrote NOTHING (zero creates, zero
// updates) yet recorded at least one failure is a total failure — exiting 0 in
// that case would let a CI/script step believe the export succeeded when in
// fact nothing reached GitHub. Returns a CommandError to throw in that case, or
// undefined when the batch should succeed (exit 0):
//   - empty plan (nothing to do)                       → success
//   - any creates/updates landed (partial or full)     → success (per-item
//     failures are already reported; the batch still wrote real changes)
//   - non-empty plan, nothing written, >=1 failure     → GENERIC_FAILURE
/**
 * Decide the exit status of a completed `export --apply` batch.
 *
 * Per-item continuation is intentional (one bad item never aborts the batch),
 * but the batch as a whole must still report honestly: a non-empty plan that
 * wrote NOTHING while recording at least one failure is a total failure, so it
 * returns a {@link CommandError} to throw; otherwise `undefined` (exit 0).
 *
 * @param plan - The plan that was applied.
 * @param result - What the apply loop actually wrote.
 * @param repo - Target repo, included in the failure message.
 * @returns A `CommandError` to throw on total failure, else `undefined`.
 */
export function applyOutcomeError(plan, result, repo) {
    if (plan.length > 0 && result.created === 0 && result.updated === 0 && result.failed > 0) {
        return new CommandError(`All ${result.failed} item(s) failed to apply to ${repo}; ` +
            "no issues were created or updated. See errors above.", EXIT_CODE.GENERIC_FAILURE);
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// runExport — shared handler for the `pm github export` exporter + command
// ---------------------------------------------------------------------------
//
// Export is SAFE BY DEFAULT: it previews the create/update plan and writes
// NOTHING. Real writes happen only with --apply (or --no-dry-run / legacy
// --push) AND a token AND --repo <owner/repo>. With --repo, items already
// linked to an issue in that repo (via the `gh:repo#N` provenance tag) are
// UPDATEd (upsert) rather than duplicated. --label-map translates pm tags to
// GitHub labels. --json returns the plan object; we never write our own
// stdout in JSON mode (pm renders the return value). Used by both the
// `registerExporter("github", ...)` entry point and the `pm github export`
// command so the surface stays consistent.
/**
 * Shared handler for the `pm github export` exporter and command.
 *
 * Export is SAFE BY DEFAULT: it previews the create/update plan and writes
 * nothing unless the user opts in with `--apply` (plus a token and `--repo`).
 * Items already linked to an issue in `--repo` are upserted rather than
 * duplicated; `--label-map` translates pm tags to GitHub labels.
 */
async function runExport(ctx) {
    const options = ctx.options || {};
    const jsonMode = ctx.global?.json === true;
    const format = optionString(options, "format") || "json";
    const repo = optionString(options, "repo") || ctx.args?.[0];
    const apply = exportWillApply(options);
    const idsProvided = optionProvided(options, "ids");
    const scopedIds = optionCsv(options, "ids");
    const labelMap = parseLabelMap(options, "label-map", "labelMap");
    if (idsProvided && scopedIds.length === 0) {
        throw new CommandError("--ids requires at least one pm item id (comma-separated), e.g. --ids pm-123,pm-456.", EXIT_CODE.USAGE);
    }
    const allItems = readPmItems(ctx.pm_root);
    const scoped = scopeItemsByIds(allItems, scopedIds.length > 0 ? scopedIds : undefined);
    if (scoped.missing.length > 0) {
        throw new CommandError(`--ids included unknown pm item id(s): ${scoped.missing.join(", ")}`, EXIT_CODE.NOT_FOUND);
    }
    const plan = buildExportPlan(scoped.selected, repo, labelMap);
    const creates = plan.filter((e) => e.action === "create").length;
    const updates = plan.filter((e) => e.action === "update").length;
    if (!apply) {
        // Dry-run (default). Emit the plan; in JSON mode return it silently.
        if (!jsonMode) {
            if (format === "md" || format === "markdown") {
                const md = plan
                    .map((e) => {
                    const head = e.action === "update" ? `## [update #${e.number}] ${e.payload.title}` : `## [create] ${e.payload.title}`;
                    return `${head}\n\n${e.payload.body}\n\n_labels: ${e.payload.labels.join(", ")} · state: ${e.payload.state}_\n`;
                })
                    .join("\n");
                // Route the human preview to STDERR so STDOUT stays only the
                // host-rendered return value (parseable JSON when the caller passes
                // the global --json). Writing the preview to stdout via console.log
                // used to corrupt `pm github export --format json` output: the host
                // also renders the exporter's return object to stdout, yielding JSON
                // immediately followed by trailing YAML/markdown — not valid JSON.
                console.error(md);
            }
            else {
                console.error(JSON.stringify(plan, null, 2));
            }
            const scopeNote = scopedIds.length > 0
                ? ` Scoped to ${scoped.selected.length} item(s) via --ids.`
                : "";
            const labelNote = labelMap && labelMap.size > 0
                ? ` Label map applied (${labelMap.size} mapping(s)).`
                : "";
            console.error(`[dry-run] Would create ${creates} and update ${updates} issue(s)` +
                `${repo ? ` on ${repo}` : " (no --repo: all treated as create)"}. ` +
                scopeNote +
                labelNote +
                "Re-run with --apply --repo <owner/repo> to write to GitHub.");
        }
        return {
            dry_run: true,
            plan,
            would_create: creates,
            would_update: updates,
            repo,
            ...(labelMap ? { label_map: Object.fromEntries(labelMap) } : {}),
            ...(scopedIds.length > 0 ? { scoped_ids: scopedIds } : {}),
        };
    }
    // --apply path: real writes. Require token + repo.
    const token = resolveGitHubToken();
    if (!token) {
        throw new CommandError("--apply requires a GitHub token (set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`).", EXIT_CODE.USAGE);
    }
    if (!repo || !repo.includes("/")) {
        throw new CommandError("--apply requires --repo <owner/repo>.", EXIT_CODE.USAGE);
    }
    // Apply each item independently: a single failed create/update is
    // recorded and the batch CONTINUES, so one bad item (e.g. a 422 for a
    // missing label) never abandons the rest of the export.
    const { created, updated, failed, failures } = await applyExportPlan(plan, repo, token, request);
    if (!jsonMode) {
        console.error(`Created ${created} and updated ${updated} issue(s) on ${repo}.`);
        if (failed > 0) {
            console.error(`${failed} item(s) failed and were skipped (see errors above).`);
        }
    }
    // Honest batch-level exit status. Per-item failures are tolerated as long
    // as SOMETHING was written, but a non-empty plan that wrote nothing and
    // recorded only failures must exit non-zero — otherwise a CI/script step
    // sees success when no issue reached GitHub. Thrown AFTER the summary so
    // the per-item errors and the summary line are emitted first for context.
    const outcomeError = applyOutcomeError(plan, { created, updated, failed, failures }, repo);
    if (outcomeError)
        throw outcomeError;
    return {
        applied: true,
        created,
        updated,
        failed,
        failures,
        repo,
        ...(labelMap ? { label_map: Object.fromEntries(labelMap) } : {}),
        ...(scopedIds.length > 0 ? { scoped_ids: scopedIds } : {}),
    };
}
// ---------------------------------------------------------------------------
// Search provider — reach GitHub from `pm search` for imported items
// ---------------------------------------------------------------------------
//
// The pm search runtime maps a provider's hits back to LOCAL item documents by
// id and DROPS any hit whose id is not a local item (see
// normalizeExtensionProviderHits in @unbrained/pm-cli). So this provider cannot
// surface arbitrary remote issues; instead it asks GitHub which issues in the
// repo match the query, then returns hits for the pm items that are already
// imported from those issues (matched by the `gh:repo#N` provenance tag).
// Semantics: "find my imported pm items whose upstream GitHub issue matches Q".
/**
 * Build the GitHub Search-API URL for issues in one repo matching a free-text query.
 *
 * Restricted to `type:issue repo:<repo>` so a search never leaks across repos.
 *
 * @param repo - The `owner/repo` to search within.
 * @param query - Free-text query string.
 * @returns The encoded search URL.
 */
export function buildSearchUrl(repo, query) {
    const q = `${query} repo:${repo} type:issue`;
    return `${githubApiBase()}/search/issues?q=${encodeURIComponent(q)}&per_page=100`;
}
/**
 * Map GitHub search result numbers to local pm-item hits.
 *
 * For every returned issue number, looks up the pm item carrying the matching
 * `gh:repo#N` provenance tag; only locally-present items become hits (the
 * runtime would drop the rest anyway). Score preserves GitHub's ranking,
 * normalized into `(0, 1]` so hits clear pm's default threshold.
 *
 * @param matchedNumbers - Issue numbers GitHub returned, best-first.
 * @param repo - The repo the search ran against.
 * @param itemsByProvenance - Local items keyed `owner/repo#N`.
 * @returns One hit per locally-present matching item.
 */
export function mapSearchHits(matchedNumbers, repo, itemsByProvenance) {
    const repoLc = repo.toLowerCase();
    const hits = [];
    const seen = new Set();
    let rank = matchedNumbers.length;
    for (const number of matchedNumbers) {
        const item = itemsByProvenance.get(`${repoLc}#${number}`);
        if (!item?.id || seen.has(item.id)) {
            rank--;
            continue;
        }
        seen.add(item.id);
        // Preserve GitHub's ranking: earlier results score higher. Normalize to
        // (0, 1] so hits clear pm's default score threshold.
        hits.push({
            id: item.id,
            score: matchedNumbers.length > 0 ? rank / matchedNumbers.length : 1,
            matched_fields: [`github:${repoLc}#${number}`],
        });
        rank--;
    }
    return hits;
}
/**
 * Resolve the search target repo for the GitHub search provider.
 *
 * An explicit option wins, then the `PM_GITHUB_REPO` env var so a workspace can
 * pin its upstream. Returns `undefined` when neither yields an `owner/repo`.
 *
 * @param options - The raw option object from the search context.
 * @returns The resolved `owner/repo`, or `undefined`.
 */
export function resolveSearchRepo(options) {
    const opt = optionString(options, "repo", "github-repo", "githubRepo");
    if (opt && opt.includes("/"))
        return opt;
    const env = process.env.PM_GITHUB_REPO;
    if (env && env.includes("/"))
        return env.trim();
    return undefined;
}
// Detect whether the `gh` CLI is installed and runnable on PATH.
function detectGhCli() {
    try {
        const r = spawnSync("gh", ["--version"], { encoding: "utf-8" });
        return r.status === 0;
    }
    catch {
        return false;
    }
}
// Report which token source is active: `env` (GITHUB_TOKEN/GH_TOKEN), `gh` (gh
// auth), or `none`.
function detectTokenSource() {
    if ((process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim())
        return "env";
    const token = resolveGitHubToken();
    return token ? "gh" : "none";
}
// Command handler for `pm github validate`: checks token source, gh CLI, rate
// limit, and the reachable issue counts for the configured repo.
async function runValidate(ctx) {
    const options = ctx.options || {};
    const repo = optionString(options, "repo") || ctx.args?.[0];
    const gh_cli = detectGhCli();
    const token_source = detectTokenSource();
    const token = resolveGitHubToken();
    const report = {
        ok: true,
        gh_cli,
        token: Boolean(token),
        token_source,
        messages: [],
    };
    if (!token) {
        report.messages.push("No GitHub token resolvable (GITHUB_TOKEN/GH_TOKEN or `gh auth login`); " +
            "reads are capped at 60 req/hr and private repos are unreachable.");
    }
    else {
        report.messages.push(`GitHub token resolved via ${token_source === "env" ? "environment" : "gh CLI"}.`);
    }
    if (!gh_cli)
        report.messages.push("`gh` CLI not found on PATH (optional; only used to borrow a token).");
    if (repo) {
        if (!repo.includes("/")) {
            report.ok = false;
            report.messages.push(`Invalid --repo "${repo}" (expected owner/repo).`);
        }
        else {
            report.repo = repo;
            try {
                const res = await fetchJSON(`${githubApiBase()}/repos/${repo}`, token);
                report.repo_accessible = res.status >= 200 && res.status < 300;
                report.repo_status = res.status;
                const rate = parseRateLimit(res.headers);
                if (rate.remaining !== undefined)
                    report.rate_limit_remaining = rate.remaining;
                if (rate.limit !== undefined)
                    report.rate_limit_limit = rate.limit;
                if (rate.reset !== undefined)
                    report.rate_limit_reset = rate.reset;
                report.rate_limit_low = rate.low;
                const rateLine = formatRateLimit(rate);
                if (rateLine)
                    report.messages.push(rateLine);
                if (rate.low) {
                    report.messages.push(`WARNING: GitHub API quota is low (${rate.remaining} left)` +
                        (token ? "" : " — set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` to raise it (60→5000/hr)") +
                        ".");
                }
                if (report.repo_accessible) {
                    report.messages.push(`Repo ${repo} is accessible (HTTP ${res.status}).`);
                }
                else {
                    report.ok = false;
                    report.messages.push(`Repo ${repo} returned HTTP ${res.status}.`);
                }
            }
            catch (err) {
                report.ok = false;
                report.repo_accessible = false;
                report.messages.push(`Repo ${repo} check failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    else {
        report.messages.push("No --repo given; skipped repo accessibility check.");
    }
    return report;
}
// ---------------------------------------------------------------------------
// Preflight — local guard for mutating github commands (no network in-hook)
// ---------------------------------------------------------------------------
// Returns true if the command/args describe a github operation that will MUTATE
// state (a write import, an export --push, or a non-dry-run sync).
// ===========================================================================
// GitHub Projects v2 — GraphQL client, operations, and command handlers.
// Projects v2 is a GraphQL-only API; this section speaks it via the shared
// `request` infrastructure (retry/backoff/rate-limit) already defined above.
// The pure plan/mapping logic lives in ./projects.ts for unit-testability.
// ===========================================================================
// GraphQL endpoint. Composed from the overridable API base so the HTTP
// boundary tests can point the whole stack (REST + GraphQL) at one local
// server; production always resolves to https://api.github.com/graphql.
function graphqlUrl() {
    return `${githubApiBase()}/graphql`;
}
// One GraphQL round-trip. GraphQL reports business errors as HTTP 200 with an
// `errors` array, so we surface those explicitly. The combined user+org queries
// below intentionally return a partial error for the wrong owner type while the
// right one still resolves; we only throw when there is NO usable data.
async function githubGraphQL(token, query, variables) {
    if (!token) {
        throw new CommandError("GitHub GraphQL requires a token (set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`).", EXIT_CODE.USAGE);
    }
    const payload = JSON.stringify({ query, variables });
    const res = await request("POST", graphqlUrl(), token, payload);
    let parsed;
    try {
        parsed = JSON.parse(res.body);
    }
    catch {
        throw new CommandError(`GitHub GraphQL returned an unparseable response (HTTP ${res.status}).`);
    }
    if (parsed.data === undefined || parsed.data === null) {
        const messages = (parsed.errors ?? []).map((e) => e.message).join("; ");
        throw new CommandError(`GitHub GraphQL error${messages ? `: ${messages}` : ` (HTTP ${res.status})`}.`);
    }
    return parsed.data;
}
const STATUS_FIELD_GQL = `
  statusField: field(name: "Status") {
    ... on ProjectV2SingleSelectField { id name options { id name } }
  }`;
/**
 * Resolve a project reference into its GraphQL id and Status field.
 *
 * The owner may be a user or an org, and GraphQL requires us to pick which
 * owner-type field to query, so this asks both in one request and keeps
 * whichever connection resolves. Throws {@link CommandError} (NOT_FOUND) when
 * neither resolves (wrong owner, wrong number, or missing project scope).
 *
 * @param ref - The `owner/number` board reference.
 * @param token - GitHub token (the GraphQL call requires one).
 * @returns The board metadata including its Status field, if any.
 */
async function resolveProject(ref, token) {
    const query = `
    query($owner:String!,$number:Int!){
      user(login:$owner){ projectV2(number:$number){ id title url ${STATUS_FIELD_GQL} } }
      organization(login:$owner){ projectV2(number:$number){ id title url ${STATUS_FIELD_GQL} } }
    }`;
    const data = await githubGraphQL(token, query, { owner: ref.owner, number: ref.number });
    const userNode = data.user?.projectV2;
    const orgNode = data.organization?.projectV2;
    const node = userNode ?? orgNode;
    if (!node) {
        throw new CommandError(`Project ${ref.owner}/${ref.number} not found or not accessible with the resolved token ` +
            "(need `project`/`read:project` scope; set GITHUB_TOKEN/GH_TOKEN or `gh auth login`).", EXIT_CODE.NOT_FOUND);
    }
    const ownerType = userNode ? "user" : "organization";
    const sf = node.statusField;
    const statusField = sf && sf.id ? { id: sf.id, name: sf.name, options: sf.options ?? [] } : undefined;
    return { id: node.id, title: node.title ?? "", url: node.url ?? "", ownerType, statusField };
}
/**
 * Normalize a raw GraphQL project-item node into the {@link ProjectItem} model.
 *
 * Tolerates null/undefined nodes and missing content, returning a placeholder
 * `Unknown` content for redacted or unmodeled item types so they are counted but
 * never mutated.
 *
 * @param n - The raw GraphQL node (may be null).
 * @returns The normalized project item.
 */
function normalizeProjectItemNode(n) {
    const c = n?.content ?? { __typename: "Unknown" };
    const tn = c.__typename;
    let content;
    if (tn === "DraftIssue") {
        content = { typename: "DraftIssue", title: c.title ?? "", body: c.body ?? undefined };
    }
    else if (tn === "Issue") {
        content = {
            typename: "Issue",
            title: c.title ?? "",
            number: c.number,
            url: c.url,
            state: typeof c.state === "string" ? c.state.toLowerCase() : undefined,
            stateReason: typeof c.stateReason === "string" ? c.stateReason.toLowerCase() : null,
            repo: c.repository?.nameWithOwner,
        };
    }
    else if (tn === "PullRequest") {
        content = {
            typename: "PullRequest",
            title: c.title ?? "",
            number: c.number,
            url: c.url,
            state: typeof c.state === "string" ? c.state.toLowerCase() : undefined,
            repo: c.repository?.nameWithOwner,
        };
    }
    else {
        // Redacted or an item type we do not model — carry a placeholder so it is
        // counted but never mutated.
        content = { typename: "Unknown", title: "" };
    }
    const sv = n?.fieldValueByName;
    return {
        id: n?.id ?? "",
        statusOptionId: sv?.optionId ?? undefined,
        statusName: sv?.name ?? undefined,
        content,
    };
}
/**
 * Fetch every item on a board, paging through the connection at 100/page.
 *
 * Walks the GraphQL cursor until `hasNextPage` is false, normalizing each node
 * via {@link normalizeProjectItemNode}. Stops cleanly when a page reports no
 * connection so the loop never truncates silently nor spins on a missing cursor.
 *
 * @param projectId - GraphQL node id of the board.
 * @param token - GitHub token.
 * @returns Every item on the board, in page order.
 */
async function fetchProjectItems(projectId, token) {
    const query = `
    query($id:ID!,$cursor:String){
      node(id:$id){ ... on ProjectV2 {
        items(first:100, after:$cursor){
          pageInfo{ hasNextPage endCursor }
          nodes{
            id
            fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name optionId } }
            content{
              __typename
              ... on DraftIssue { title body }
              ... on Issue { number title url state stateReason repository{ nameWithOwner } }
              ... on PullRequest { number title url state repository{ nameWithOwner } }
            }
          }
        }
      }}
    }`;
    const items = [];
    let cursor;
    for (;;) {
        const data = await githubGraphQL(token, query, { id: projectId, cursor: cursor ?? null });
        const conn = data.node?.items;
        if (!conn)
            break;
        for (const n of conn.nodes ?? []) {
            if (n)
                items.push(normalizeProjectItemNode(n));
        }
        if (conn.pageInfo?.hasNextPage && conn.pageInfo.endCursor) {
            cursor = conn.pageInfo.endCursor;
        }
        else {
            break;
        }
    }
    return items;
}
/**
 * Add a draft issue to a Projects v2 board and return the new project-item id.
 *
 * @param projectId - GraphQL node id of the board.
 * @param title - Draft issue title.
 * @param body - Draft issue body (empty string when absent).
 * @param token - GitHub token.
 * @returns The newly created project-item id.
 */
async function gqlAddDraft(projectId, title, body, token) {
    const q = `mutation($p:ID!,$t:String!,$b:String){ addProjectV2DraftIssue(input:{projectId:$p,title:$t,body:$b}){ projectItem{ id } } }`;
    const d = await githubGraphQL(token, q, { p: projectId, t: title, b: body ?? "" });
    const id = d.addProjectV2DraftIssue?.projectItem?.id;
    if (!id)
        throw new CommandError("addProjectV2DraftIssue returned no item id.");
    return id;
}
/**
 * Link an existing repo issue/PR to a board and return the new project-item id.
 *
 * @param projectId - GraphQL node id of the board.
 * @param contentId - GraphQL node id of the issue/PR to attach.
 * @param token - GitHub token.
 * @returns The newly created project-item id.
 */
async function gqlAddIssue(projectId, contentId, token) {
    const q = `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }`;
    const d = await githubGraphQL(token, q, { p: projectId, c: contentId });
    const id = d.addProjectV2ItemById?.item?.id;
    if (!id)
        throw new CommandError("addProjectV2ItemById returned no item id.");
    return id;
}
// Set a project item's single-select Status field to the given option id.
async function gqlSetStatus(projectId, itemId, fieldId, optionId, token) {
    const q = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }`;
    await githubGraphQL(token, q, { p: projectId, i: itemId, f: fieldId, o: optionId });
}
/**
 * Resolve the GraphQL node id of a repo's issue or PR by number.
 *
 * @param repo - `owner/repo` to look up in.
 * @param number - The issue/PR number.
 * @param token - GitHub token.
 * @returns The node id, or `undefined` when not found or the repo ref is malformed.
 */
async function gqlResolveIssueNodeId(repo, number, token) {
    const [owner, name] = repo.split("/");
    if (!owner || !name)
        return undefined;
    const q = `query($o:String!,$n:String!,$num:Int!){ repository(owner:$o,name:$n){ issueOrPullRequest(number:$num){ ... on Issue { id } ... on PullRequest { id } } } }`;
    const d = await githubGraphQL(token, q, { o: owner, n: name, num: number });
    return d.repository?.issueOrPullRequest?.id ?? undefined;
}
/** Build a factual close reason for a project-import item entering `closed`. */
function projectImportCloseReason(ref, c) {
    if (c.repo && typeof c.number === "number") {
        return `GitHub ${c.repo}#${c.number} closed (project ${ref.owner}/${ref.number})`;
    }
    return `GitHub project ${ref.owner}/${ref.number} item closed`;
}
/**
 * Compose a human-readable, provenance-bearing description for an imported
 * project item.
 *
 * Parallels the issue-import description: joins the board ref, item kind, issue
 * link, URL, and state into one summary string written to the pm item.
 *
 * @param ref - The board the item came from.
 * @param c - The item's resolved content.
 * @returns The composed description line.
 */
function projectItemDescription(ref, c) {
    const parts = [`GH project item ${ref.owner}/${ref.number}`];
    if (c.typename === "DraftIssue")
        parts.push("· draft issue");
    if (c.repo && typeof c.number === "number")
        parts.push(`· ${c.repo}#${c.number}`);
    if (c.url)
        parts.push(`· ${c.url}`);
    if (c.state)
        parts.push(`· state ${c.state}`);
    return parts.join(" ");
}
// Paginate a GitHub Projects v2 connection until pageInfo.hasNextPage is false.
// `fetchPage` returns the connection object (nodes + pageInfo) for the given
// cursor and may return null/undefined to stop early. Pure over the injected
// fetcher so the multi-page contract (no silent truncation, cursor threading)
// is unit-testable without network I/O. Mirrors the fetchProjectItems loop.
export async function collectProjectsV2Pages(fetchPage) {
    const out = [];
    let cursor;
    for (;;) {
        const conn = await fetchPage(cursor);
        if (!conn)
            break;
        for (const n of conn.nodes ?? [])
            if (n)
                out.push(n);
        // Continue only when GitHub explicitly reports more pages AND gives us a
        // cursor; otherwise stop so we never silently truncate by paging past the
        // end, nor loop forever on a missing endCursor.
        if (conn.pageInfo?.hasNextPage && conn.pageInfo?.endCursor) {
            cursor = conn.pageInfo.endCursor;
        }
        else {
            break;
        }
    }
    return out;
}
/**
 * Resolve and paginate the `projectsV2` connection for a user-or-org owner.
 *
 * A login is either a user or an organization, never both; querying both in one
 * request resolves the owner type without an extra round-trip, then this keeps
 * paginating the connection that actually exists so owners with more than 100
 * projects are fully listed instead of silently truncated.
 *
 * @param owner - The user or org login.
 * @param graphQL - Injectable transport (query + variables → data), for tests.
 * @returns Every project-summary node for the owner.
 */
export async function listOwnerProjectsV2Nodes(owner, graphQL) {
    let ownerType = null;
    return collectProjectsV2Pages(async (cursor) => {
        const q = `
      query($owner:String!,$cursor:String){
        user(login:$owner){ projectsV2(first:100, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ number title url closed shortDescription } } }
        organization(login:$owner){ projectsV2(first:100, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ number title url closed shortDescription } } }
      }`;
        const d = await graphQL(q, { owner, cursor: cursor ?? null });
        if (ownerType === null) {
            if (d.user?.projectsV2)
                ownerType = "user";
            else if (d.organization?.projectsV2)
                ownerType = "organization";
        }
        return ownerType === "organization" ? d.organization?.projectsV2 : d.user?.projectsV2;
    });
}
/**
 * Command handler for `pm github project list`: list a user/org's Projects v2.
 *
 * @param ctx - The command-handler context.
 */
async function runProjectList(ctx) {
    const options = ctx.options || {};
    const owner = optionString(options, "owner") || ctx.args?.[0];
    if (!owner) {
        throw new CommandError("Usage: pm github project list <owner>  (a GitHub user or org login)", EXIT_CODE.USAGE);
    }
    const token = resolveGitHubToken();
    const nodes = await listOwnerProjectsV2Nodes(owner, (q, vars) => githubGraphQL(token, q, vars));
    const projects = nodes.map((n) => ({
        number: n.number,
        title: n.title ?? "",
        url: n.url ?? "",
        closed: !!n.closed,
        description: n.shortDescription ?? undefined,
    }));
    if (ctx.global?.json !== true) {
        if (projects.length === 0) {
            console.error(`No Projects v2 found for ${owner} (or none accessible with the resolved token).`);
        }
        else {
            console.error(`Projects for ${owner}:`);
            for (const p of projects) {
                console.error(`  #${p.number}  ${p.closed ? "[closed] " : ""}${p.title}  ${p.url}`);
            }
        }
    }
    return { owner, projects };
}
// --- project fields --------------------------------------------------------
/**
 * Command handler for `pm github project fields`: show a board's fields.
 *
 * Resolves the board, then lists its fields and (for the Status single-select)
 * its option names so the caller can build a `--status-map`.
 *
 * @param ctx - The command-handler context.
 */
async function runProjectFields(ctx) {
    const options = ctx.options || {};
    const ref = parseProjectRef(optionString(options, "project") || ctx.args?.[0]);
    if (!ref) {
        throw new CommandError("Usage: pm github project fields <owner/number>  (e.g. pm github project fields unbraind/5)", EXIT_CODE.USAGE);
    }
    const token = resolveGitHubToken();
    const meta = await resolveProject(ref, token);
    const q = `
    query($id:ID!){ node(id:$id){ ... on ProjectV2 {
      fields(first:50){ nodes{
        __typename
        ... on ProjectV2FieldCommon { name dataType }
        ... on ProjectV2SingleSelectField { name options{ name } }
      } }
    }}}`;
    const d = await githubGraphQL(token, q, { id: meta.id });
    const fields = (d.node?.fields?.nodes ?? []).filter((f) => f !== null).map((f) => ({
        name: f.name,
        type: f.dataType ?? f.__typename,
        options: Array.isArray(f.options) ? f.options.map((o) => o.name) : undefined,
    }));
    if (ctx.global?.json !== true) {
        console.error(`Project ${ref.owner}/${ref.number} — ${meta.title} (${meta.ownerType})`);
        console.error(`  ${meta.url}`);
        console.error(`  Status field: ${meta.statusField ? meta.statusField.options.map((o) => o.name).join(" | ") : "(none — pushes cannot set status)"}`);
        console.error("  Fields:");
        for (const f of fields) {
            console.error(`    ${f.name} (${f.type})${f.options ? `: ${f.options.join(", ")}` : ""}`);
        }
    }
    return { project: meta, fields };
}
// --- project import --------------------------------------------------------
/**
 * Command handler for `pm github project import`: import board items as pm items.
 *
 * Idempotent: items already linked (by project tag or wrapped issue) are updated,
 * the rest are created. Status is refreshed only from an explicit, resolvable
 * board mapping (never a guess), honoring the no-data-loss invariant.
 *
 * @param ctx - The command-handler context.
 */
async function runProjectImport(ctx) {
    const options = ctx.options || {};
    const ref = parseProjectRef(optionString(options, "project") || ctx.args?.[0]);
    if (!ref) {
        throw new CommandError("Usage: pm github project import <owner/number> [--dry-run] [--status-map pm=Option,...] [--type <type>]", EXIT_CODE.USAGE);
    }
    const dryRun = optionEnabled(options, "dry-run", "dryRun");
    const itemType = optionString(options, "type") || "Task";
    const statusMap = parseStatusMap(optionCsv(options, "status-map", "statusMap"));
    const token = resolveGitHubToken();
    const meta = await resolveProject(ref, token);
    const projectItems = await fetchProjectItems(meta.id, token);
    console.error(`Found ${projectItems.length} item(s) on ${ref.owner}/${ref.number} — ${meta.title}.`);
    // Reading the local store is non-mutating and keeps dry-run faithful: linked
    // project items must preview as updates, not misleading duplicate creates.
    const pmItems = readPmItems(ctx.pm_root);
    const plan = buildProjectImportPlan(projectItems, ref, pmItems, statusMap);
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    for (const entry of plan) {
        const description = projectItemDescription(ref, entry.content);
        if (dryRun) {
            console.error(`  [dry-run] ${entry.action} "${entry.title}" (${entry.status})`);
            if (entry.action === "create")
                imported++;
            else
                updated++;
            continue;
        }
        if (entry.action === "update" && entry.pmId) {
            const updArgs = [
                "--path", ctx.pm_root, "update", entry.pmId,
                "--title", entry.title,
                "--description", description,
                "--tags", entry.tags.join(","),
                "--message", `Re-imported from GitHub project ${ref.owner}/${ref.number}`,
            ];
            if (entry.body)
                updArgs.push("--body", entry.body);
            // Refresh the mapped pm status alongside the other fields — but ONLY when
            // the board Status mapped to a known pm status. An unknown mapping is
            // skipped (no --status) so we never overwrite a real pm state with a guess
            // (no data loss). `entry.status` carries a fallback for the create path;
            // `entry.mappedStatus` is set only for an explicit, resolvable mapping.
            // A `closed` mapping cannot go through `pm update --status closed`
            // (governance require_close_reason rejects it since pm-cli 2026.8.3);
            // the update omits --status and a separate `pm close` records the reason.
            const closeAfterUpdate = entry.mappedStatus === "closed";
            if (entry.mappedStatus && !closeAfterUpdate)
                updArgs.push("--status", entry.mappedStatus);
            const upd = pmRun(updArgs);
            if (!upd.ok) {
                console.error(`  ${entry.title}: update failed — ${upd.stderr}`);
                skipped++;
                continue;
            }
            if (closeAfterUpdate) {
                const close = pmRun(["--path", ctx.pm_root, "close", entry.pmId, "--reason", projectImportCloseReason(ref, entry.content)]);
                if (!close.ok) {
                    console.error(`  ${entry.title}: close failed — ${close.stderr}`);
                    skipped++;
                    continue;
                }
            }
            updated++;
            continue;
        }
        // A `closed` upstream item cannot be born closed: governance
        // `require_close_reason` rejects `pm create --status closed` (pm-cli
        // 2026.8.3+). Create open, then close through `pm close` with factual
        // provenance. `--json` is needed to read the assigned id for the close.
        const createStatus = entry.status === "closed" ? "open" : entry.status;
        const mustClose = entry.status === "closed";
        const createArgs = [
            "--path", ctx.pm_root, "create",
            "--title", entry.title,
            "--type", itemType,
            "--status", createStatus,
            "--description", description,
            "--tags", entry.tags.join(","),
            "--message", `Imported from GitHub project ${ref.owner}/${ref.number}`,
        ];
        if (entry.body)
            createArgs.push("--body", entry.body);
        if (mustClose)
            createArgs.push("--json");
        const created = pmRun(createArgs);
        if (!created.ok) {
            console.error(`  ${entry.title}: create failed — ${created.stderr}`);
            skipped++;
            continue;
        }
        if (mustClose) {
            const createdId = parseCreatedItemId(created.stdout);
            if (!createdId) {
                console.error(`  ${entry.title}: close failed — could not read created item id`);
                skipped++;
                continue;
            }
            const close = pmRun(["--path", ctx.pm_root, "close", createdId, "--reason", projectImportCloseReason(ref, entry.content)]);
            if (!close.ok) {
                console.error(`  ${entry.title}: close failed — ${close.stderr}`);
                skipped++;
                continue;
            }
        }
        imported++;
    }
    if (dryRun) {
        console.error(`[dry-run] Would import ${imported}, update ${updated}.`);
        return { dryRun: true, project: `${ref.owner}/${ref.number}`, wouldImport: imported, wouldUpdate: updated, planned: plan.length };
    }
    console.error(`Imported ${imported} new, updated ${updated}, skipped ${skipped}.`);
    if (imported === 0 && updated === 0 && skipped > 0) {
        throw new CommandError(`Imported 0 project item(s); ${skipped} failed.`);
    }
    return { imported, updated, skipped, project: `${ref.owner}/${ref.number}`, planned: plan.length };
}
// --- project sync (bidirectional) ------------------------------------------
/**
 * Push one pm item's status onto its board item.
 *
 * Tolerates a missing target option (writes the item but skips the Status set).
 * Returns whether a real change was made and an optional error string so the
 * caller can continue the batch per-item.
 *
 * @param entry - The push-plan entry to execute.
 * @param meta - The board metadata (id, Status field).
 * @param ref - The board reference (for the provenance tag).
 * @param pmById - Local pm items keyed by id (for body lookup and tagging).
 * @param pmRoot - Workspace root for the `pm` tag write.
 * @param token - GitHub token for the GraphQL calls.
 * @returns Whether the item changed, plus an optional error message.
 */
async function applyPushEntry(entry, meta, ref, pmById, pmRoot, token) {
    try {
        let itemId = entry.itemId;
        if (entry.action === "add-draft") {
            const pm = pmById.get(entry.pmId);
            itemId = await gqlAddDraft(meta.id, entry.title, pm?.body || pm?.description, token);
        }
        else if (entry.action === "add-issue") {
            if (!entry.issueRepo || typeof entry.issueNumber !== "number") {
                return { changed: false, error: "add-issue entry missing issue coordinates" };
            }
            const contentId = await gqlResolveIssueNodeId(entry.issueRepo, entry.issueNumber, token);
            if (!contentId)
                return { changed: false, error: `could not resolve node id for ${entry.issueRepo}#${entry.issueNumber}` };
            itemId = await gqlAddIssue(meta.id, contentId, token);
        }
        if (!itemId)
            return { changed: false, error: "no project item id to act on" };
        if (entry.targetOptionId && meta.statusField) {
            await gqlSetStatus(meta.id, itemId, meta.statusField.id, entry.targetOptionId, token);
        }
        // Ensure the pm item carries the project provenance tag so future syncs are
        // idempotent (never strips existing tags; only adds the missing one).
        const pm = pmById.get(entry.pmId);
        if (pm?.id) {
            const tag = projectItemTag(ref, itemId);
            const existingTags = pm.tags ?? [];
            if (!existingTags.includes(tag)) {
                const upd = pmRun([
                    "--path", pmRoot, "update", pm.id,
                    "--tags", [...existingTags, tag].join(","),
                    "--message", `Linked to GitHub project ${ref.owner}/${ref.number}`,
                ]);
                if (!upd.ok)
                    return { changed: true, error: `linked but tag write failed — ${upd.stderr}` };
            }
        }
        return { changed: true };
    }
    catch (err) {
        return { changed: false, error: err instanceof Error ? err.message : String(err) };
    }
}
// Build the pm CLI argv that applies one pull (project → pm) status transition.
// Pure so the lifecycle contract is unit-testable without spawning `pm`.
//
// pm CLI contracts (verified against pm 2026.7.11):
//   - `pm close` records `closed_at` + `close_reason` and moves the item to the
//     terminal `closed` state, but REFUSES on already-terminal items ("use
//     --force to close again"). It only ever produces `closed`, never `canceled`.
//   - `canceled` is a DISTINCT terminal state set via `pm update --status
//     canceled`; `pm update --status canceled` is permitted on both active and
//     terminal items, and `--close-reason` records the lifecycle rationale.
//     `pm list-canceled` projects `close_reason` (not `closed_at`), so the close
//     reason is the lifecycle metadata that must be recorded for `canceled`.
//
// Routing `canceled` through `pm close` (as one review suggestion proposed)
// would conflate `canceled` with `closed`, lose the distinct terminal state,
// and fail for terminal→canceled transitions. Recording `--close-reason` on the
// `pm update` keeps the distinction AND the lifecycle metadata, and works for
// active→canceled and terminal→canceled alike.
/**
 * Build the `pm` CLI argv that applies one pull (project → pm) status transition.
 *
 * Pure so the pm lifecycle contract is unit-testable without spawning `pm`:
 * `closed` goes through `pm close`; `canceled` keeps its distinct terminal state
 * via `pm update --status canceled` with `--close-reason`; everything else is a
 * plain `pm update --status`. See the long note above for the pm CLI contracts.
 *
 * @param entry - The pull-plan entry to render argv for.
 * @param pmRoot - Workspace root for the `pm` invocation.
 * @returns The argv array.
 */
export function buildPullEntryArgs(entry, pmRoot) {
    const reason = `GitHub project status → ${entry.toStatus}`;
    if (entry.toStatus === "closed") {
        return ["--path", pmRoot, "close", entry.pmId, "--reason", reason];
    }
    if (entry.toStatus === "canceled") {
        return [
            "--path", pmRoot, "update", entry.pmId,
            "--status", "canceled",
            "--close-reason", reason,
            "--message", reason,
        ];
    }
    return [
        "--path", pmRoot, "update", entry.pmId,
        "--status", entry.toStatus,
        "--message", reason,
    ];
}
// Pull a board status onto its pm item. `closed` goes through `pm close`
// (records closed_at + close_reason); `canceled` keeps its distinct terminal
// state via `pm update` while recording `--close-reason`; everything else is a
// plain `pm update --status`.
function applyPullEntry(entry, pmRoot) {
    const res = pmRun(buildPullEntryArgs(entry, pmRoot));
    return res.ok ? { changed: true } : { changed: false, error: res.stderr };
}
/**
 * Command handler for `pm github project sync`: preview or apply the
 * bidirectional Projects v2 sync plan.
 *
 * Honors `--push`/`--pull` (default previews both), `--apply`, `--ids`, and the
 * `--prefer` conflict winner when both directions touch the same linked item.
 *
 * @param ctx - The command-handler context.
 */
async function runProjectSync(ctx) {
    const options = ctx.options || {};
    const ref = parseProjectRef(optionString(options, "project") || ctx.args?.[0]);
    if (!ref) {
        throw new CommandError("Usage: pm github project sync <owner/number> [--push|--pull] [--apply] [--ids pm-1,..] [--status-map pm=Option,..] [--no-add-missing] [--prefer pm|github]", EXIT_CODE.USAGE);
    }
    const wantPush = optionEnabled(options, "push");
    const wantPull = optionEnabled(options, "pull");
    const dryRunFlag = optionEnabled(options, "dry-run", "dryRun");
    const apply = optionEnabled(options, "apply") && !dryRunFlag;
    const addMissing = !optionEnabled(options, "no-add-missing", "noAddMissing");
    const prefer = (optionString(options, "prefer") || "pm").toLowerCase() === "github" ? "github" : "pm";
    const statusMap = parseStatusMap(optionCsv(options, "status-map", "statusMap"));
    const idsProvided = optionProvided(options, "ids");
    const scopedIds = optionCsv(options, "ids");
    if (idsProvided && scopedIds.length === 0) {
        throw new CommandError("--ids requires at least one pm item id (comma-separated).", EXIT_CODE.USAGE);
    }
    // Direction resolution. Preview (no --apply) shows BOTH plans unless one is
    // explicitly requested. --apply defaults to push (never mutates pm silently).
    const previewBoth = !wantPush && !wantPull;
    const doPush = previewBoth || wantPush;
    const doPull = previewBoth || wantPull;
    const applyPush = apply && (wantPush || (!wantPush && !wantPull));
    const applyPull = apply && wantPull;
    const token = resolveGitHubToken();
    if (!token) {
        throw new CommandError("pm github project sync needs a GitHub token (set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`).", EXIT_CODE.USAGE);
    }
    const meta = await resolveProject(ref, token);
    const projectItems = await fetchProjectItems(meta.id, token);
    const allPm = readPmItems(ctx.pm_root);
    const scoped = scopeItemsByIds(allPm, scopedIds.length > 0 ? scopedIds : undefined);
    if (scoped.missing.length > 0) {
        throw new CommandError(`--ids included unknown pm item id(s): ${scoped.missing.join(", ")}`, EXIT_CODE.NOT_FOUND);
    }
    const pmById = new Map();
    for (const it of scoped.selected)
        if (it.id)
            pmById.set(it.id, it);
    const pushPlan = doPush
        ? buildProjectPushPlan(scoped.selected, ref, projectItems, meta.statusField, { addMissing, statusMap })
        : undefined;
    const pullPlan = doPull
        ? buildProjectPullPlan(scoped.selected, ref, projectItems, statusMap)
        : undefined;
    // Conflict resolution when applying BOTH directions: a linked item can appear
    // in both plans. `--prefer pm` (default) lets push win (skip its pull entry);
    // `--prefer github` lets pull win (skip its push set-status entry). Adds are
    // always safe (new items are never in the pull plan).
    const pushItemIds = new Set((pushPlan?.entries ?? []).filter((e) => e.action === "set-status").map((e) => e.itemId));
    const pullItemIds = new Set((pullPlan?.entries ?? []).map((e) => e.itemId));
    const pushActionable = (pushPlan?.entries ?? []).filter((e) => e.action !== "noop");
    const pullActionable = pullPlan?.entries ?? [];
    if (!apply) {
        if (pushPlan) {
            console.error(`[dry-run] push (pm → project ${ref.owner}/${ref.number}):`);
            for (const e of pushActionable) {
                const detail = e.action === "set-status" ? `${e.currentOptionName ?? "(none)"} → ${e.targetOptionName}`
                    : e.action === "add-draft" ? `add draft${e.targetOptionName ? ` @ ${e.targetOptionName}` : ""}`
                        : `add issue ${e.issueRepo}#${e.issueNumber}${e.targetOptionName ? ` @ ${e.targetOptionName}` : ""}`;
                console.error(`  ${e.pmId} "${e.title}": ${detail}`);
            }
            for (const s of pushPlan.statusSkipped) {
                console.error(`  [skip] ${s.pmId} "${s.title}": pm status "${s.status}" maps to no board option`);
            }
            if (pushActionable.length === 0)
                console.error("  (nothing to push)");
        }
        if (pullPlan) {
            console.error(`[dry-run] pull (project ${ref.owner}/${ref.number} → pm):`);
            for (const e of pullActionable)
                console.error(`  ${e.pmId} "${e.title}": ${e.fromStatus} → ${e.toStatus}`);
            for (const s of pullPlan.statusSkipped) {
                console.error(`  [skip] item ${s.itemId}: board status "${s.optionName ?? "(none)"}" maps to no pm status`);
            }
            if (pullActionable.length === 0)
                console.error("  (nothing to pull)");
        }
        console.error("Preview only — pass --apply with --push and/or --pull to write.");
        return {
            dryRun: true,
            project: `${ref.owner}/${ref.number}`,
            push: pushPlan ? { actionable: pushActionable.length, statusSkipped: pushPlan.statusSkipped.length } : undefined,
            pull: pullPlan ? { actionable: pullActionable.length, statusSkipped: pullPlan.statusSkipped.length } : undefined,
        };
    }
    let pushed = 0;
    let pushFailed = 0;
    if (applyPush && pushPlan) {
        for (const e of pushActionable) {
            if (prefer === "github" && e.action === "set-status" && pullItemIds.has(e.itemId ?? "")) {
                continue; // pull wins for this linked item
            }
            const r = await applyPushEntry(e, meta, ref, pmById, ctx.pm_root, token);
            if (r.error && !r.changed) {
                console.error(`  push ${e.pmId} "${e.title}": ${r.error}`);
                pushFailed++;
                continue;
            }
            if (r.error)
                console.error(`  push ${e.pmId}: ${r.error}`);
            pushed++;
        }
    }
    let pulled = 0;
    let pullFailed = 0;
    if (applyPull && pullPlan) {
        for (const e of pullActionable) {
            if (prefer === "pm" && pushItemIds.has(e.itemId))
                continue; // push wins
            const r = applyPullEntry(e, ctx.pm_root);
            if (!r.changed) {
                console.error(`  pull ${e.pmId} "${e.title}": ${r.error}`);
                pullFailed++;
                continue;
            }
            pulled++;
        }
    }
    console.error(`Sync complete on ${ref.owner}/${ref.number}: pushed ${pushed}${pushFailed ? ` (${pushFailed} failed)` : ""}, ` +
        `pulled ${pulled}${pullFailed ? ` (${pullFailed} failed)` : ""}.`);
    const result = { project: `${ref.owner}/${ref.number}`, pushed, pushFailed, pulled, pullFailed, prefer };
    if (pushFailed + pullFailed > 0 && pushed + pulled === 0) {
        throw new CommandError(`Sync wrote nothing; ${pushFailed + pullFailed} operation(s) failed.`);
    }
    return result;
}
/**
 * Report whether a github subcommand will mutate GitHub.
 *
 * Feeds the host CLI's "mutating command" guard, accounting for the `--dry-run`
 * and `--apply` overrides that turn an otherwise-mutating command into a preview.
 *
 * @param command - The subcommand string (e.g. `github sync`).
 * @param options - The raw option object from the command handler.
 * @returns True when the command will perform real GitHub writes.
 */
export function isMutatingGithubCommand(command, options) {
    const cmd = (command || "").toLowerCase();
    const dryRun = optionEnabled(options, "dry-run", "dryRun");
    if (cmd === "github sync")
        return !dryRun;
    // Export is dry-run by default; it only mutates with an explicit apply
    // (--apply / --no-dry-run / legacy --push) AND no --dry-run override.
    if (cmd === "github export")
        return exportWillApply(options);
    if (cmd === "github import" || cmd === "gh-issues import")
        return !dryRun;
    if (cmd === "github project import")
        return !dryRun;
    // Project sync is dry-run by default; it only mutates with --apply (and no
    // --dry-run override).
    if (cmd === "github project sync")
        return optionEnabled(options, "apply") && !dryRun;
    return false;
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
const IMPORT_FLAGS = [
    { long: "--all", description: "Include closed issues (shorthand for --state all)" },
    { long: "--state", value_name: "state", description: "Issue state: open | closed | all (default: open)" },
    { long: "--labels", value_name: "labels", description: "Comma-separated label filter" },
    { long: "--since", value_name: "date|relative", description: "Only issues updated after this date (ISO 8601 or relative like 7d/12h/1w/30m — incremental sync)" },
    { long: "--assignee", value_name: "login", description: "Filter by assignee login" },
    { long: "--milestone", value_name: "name", description: "Filter by milestone title" },
    { long: "--include-prs", description: "Include pull requests (default: skip PRs)" },
    { long: "--skip-drafts", description: "Exclude draft pull requests (only meaningful with --include-prs)" },
    { long: "--with-comments", description: "Fetch issue comments and append them to the item body" },
    { long: "--include-comments", description: "Alias for --with-comments" },
    { long: "--comments-mode", value_name: "body|annotations|both", description: "How to persist fetched GitHub comments: `body` (default, embed in item body), `annotations` (sync to the pm item's native comments collection), or `both`. `annotations`/`both` are idempotent on re-import (dedupe by GitHub comment id)" },
    { long: "--atomic", description: "Commit the complete import as one workspace-writer-locked, crash-resumable transaction (pm-cli >=2026.7.20); compensate applied mutations on failure and report incomplete compensation" },
    { long: "--link-deps", description: "After import, map dependency references in issue bodies (`Blocked by #N`, `Depends on owner/repo#N`, `Blocks #N`) to pm dependency edges between the linked items. Idempotent; skips self- and unresolved references; ordering cycles are reported (via the SDK ordering-cycle advisory), not rejected" },
    { long: "--dry-run", description: "Preview without writing" },
    { long: "--type", value_name: "type", description: "Override pm item type (default: Issue)" },
];
const EXPORT_FLAGS = [
    { long: "--repo", value_name: "owner/repo", description: "Target GitHub repo (required for --apply; enables upsert of linked issues)" },
    { long: "--ids", value_name: "pm-1,pm-2", description: "Only export these pm item IDs (comma-separated)" },
    { long: "--apply", description: "Write to GitHub (default is a safe dry-run preview)" },
    { long: "--no-dry-run", description: "Alias for --apply" },
    { long: "--push", description: "Legacy alias for --apply" },
    { long: "--dry-run", description: "Preview only (default; always wins over --apply)" },
    { long: "--label-map", value_name: "from=to,...", description: "Translate pm tags to GitHub labels, e.g. bug=kind/bug,enhancement=kind/enhancement" },
    { long: "--format", value_name: "json|md", description: "Dry-run preview format (default: json)" },
];
const SYNC_FLAGS = [
    { long: "--repo", value_name: "owner/repo", description: "Target GitHub repo (required)" },
    { long: "--ids", value_name: "pm-1,pm-2", description: "Only sync these pm item IDs (comma-separated)" },
    { long: "--dry-run", description: "Preview the close/reopen plan without mutating GitHub" },
];
const VALIDATE_FLAGS = [
    { long: "--repo", value_name: "owner/repo", description: "Also check this repo is accessible with the resolved token" },
];
const PROJECT_LIST_FLAGS = [
    { long: "--owner", value_name: "login", description: "GitHub user or org login (or pass positionally)" },
];
const PROJECT_FIELDS_FLAGS = [
    { long: "--project", value_name: "owner/number", description: "Project reference (or pass positionally, e.g. unbraind/5)" },
];
const PROJECT_IMPORT_FLAGS = [
    { long: "--project", value_name: "owner/number", description: "Project reference (or pass positionally)" },
    { long: "--dry-run", description: "Preview without writing pm items" },
    { long: "--type", value_name: "type", description: "pm item type for created items (default: Task)" },
    { long: "--status-map", value_name: "pm=Option,...", description: "Map board Status options to pm statuses, e.g. in_progress=Doing,closed=Shipped (inverted for import)" },
];
const PROJECT_SYNC_FLAGS = [
    { long: "--project", value_name: "owner/number", description: "Project reference (or pass positionally)" },
    { long: "--push", description: "pm → project: add missing items and set their Status" },
    { long: "--pull", description: "project → pm: update pm item status from the board" },
    { long: "--apply", description: "Write changes (default is a safe dry-run preview of both directions)" },
    { long: "--ids", value_name: "pm-1,pm-2", description: "Only sync these pm item IDs (comma-separated)" },
    { long: "--status-map", value_name: "pm=Option,...", description: "Map pm status to a board Status option, e.g. in_progress=Doing,closed=Shipped" },
    { long: "--no-add-missing", description: "Push: only reconcile status of already-linked items; never add new board items" },
    { long: "--prefer", value_name: "pm|github", description: "Conflict winner when applying both directions (default: pm)" },
    { long: "--dry-run", description: "Preview only (always wins over --apply)" },
];
/**
 * Local stand-in for the SDK's `defineExtension` identity helper.
 *
 * Declared here rather than imported so this package keeps a type-only
 * dependency on `@unbrained/pm-cli` and adds no runtime module edge. The
 * generic constraint is the SDK's own, so the extension object is contract-
 * checked against {@link ExtensionModule} exactly as the imported helper would.
 */
const defineExtension = (module) => module;
export default defineExtension({
    name: "pm-github",
    version: "2026.10.4",
    activate(api) {
        // -----------------------------------------------------------------------
        // schema — declare the GitHub provenance fields so the workspace knows them
        // -----------------------------------------------------------------------
        api.registerItemFields([
            { name: "github_url", type: "string", optional: true },
            { name: "github_number", type: "number", optional: true },
            { name: "github_state", type: "string", optional: true },
            { name: "github_author", type: "string", optional: true },
            { name: "github_created_at", type: "string", optional: true },
            { name: "github_updated_at", type: "string", optional: true },
        ]);
        // -----------------------------------------------------------------------
        // preflight — safe, local guard for mutating github commands. Scoped to
        // the command paths pm-github owns (the mutating github/gh-issues paths
        // isMutatingGithubCommand recognizes) so it cannot contend with another
        // package's preflight override; an unscoped (global) override collides
        // pairwise with every other installed package's override (pm health reports
        // extension_preflight_override_collision). It runs before those commands;
        // it does NOT make network calls (that would be a surprise side effect on
        // every command) and cannot hard-block (the runtime swallows preflight
        // throws). It only surfaces a clear, early warning when a github mutation
        // is requested without a resolvable token; the authoritative validation +
        // non-zero exit lives in the handlers.
        // -----------------------------------------------------------------------
        api.registerPreflight({
            commands: [
                "github sync",
                "github export",
                "github import",
                "gh-issues import",
                "github project import",
                "github project sync",
            ],
            run: (ctx) => {
                if (isMutatingGithubCommand(ctx.command, ctx.options || {})) {
                    if (!resolveGitHubToken()) {
                        console.error("[pm-github preflight] this github command mutates remote state but no GitHub " +
                            "token is resolvable (GITHUB_TOKEN/GH_TOKEN or `gh auth login`). It will fail.");
                    }
                }
                return {};
            },
        });
        // -----------------------------------------------------------------------
        // importer — `pm github import <owner/repo>` (idempotent native pipeline)
        // -----------------------------------------------------------------------
        api.registerImporter("github", async (ctx) => {
            return runImport(ctx.args?.[0], ctx.pm_root, parseImportOptions(ctx.options || {}));
        }, {
            description: "Fetch GitHub issues from a repo and create/update pm items (idempotent " +
                "on re-import via the `gh:owner/repo#N` provenance tag). Skips pull " +
                "requests by default.",
            intent: "import GitHub issues as pm items",
            arguments: [
                { name: "owner/repo", required: true, description: "GitHub repository to import" },
            ],
            examples: [
                "pm github import unbraind/pm-cli",
                "pm github import owner/repo --since 7d",
                "pm github import owner/repo --include-comments",
                "pm github import owner/repo --comments-mode annotations",
                "pm github import owner/repo --atomic",
                "pm github import owner/repo --link-deps",
                "pm github import owner/repo --dry-run",
            ],
            flags: IMPORT_FLAGS,
            failure_hints: [
                "Pass <owner/repo>, e.g. `pm github import unbraind/pm-cli`.",
                "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` for private repos / 5000 req/hr.",
                "Re-running is safe: existing items are updated, not duplicated.",
                "Use --atomic for a durable resumable journal with reverse compensation on ordinary failures.",
            ],
        });
        // -----------------------------------------------------------------------
        // exporter — `pm github export` (pm items → GitHub issues)
        // SAFE BY DEFAULT: previews the create/update plan and writes NOTHING.
        // Real writes happen only with --apply (or --no-dry-run / legacy --push)
        // AND a token AND --repo <owner/repo>. With --repo, items already linked to
        // an issue in that repo (via the `gh:repo#N` provenance tag) are UPDATEd
        // (upsert) rather than duplicated. --json returns the plan object; we never
        // write our own stdout in JSON mode (pm renders the return value).
        // -----------------------------------------------------------------------
        api.registerExporter("github", async (ctx) => runExport(ctx), {
            description: "Export pm items as GitHub issues. SAFE BY DEFAULT: prints a create/update " +
                "plan and writes NOTHING. Use --apply --repo <owner/repo> to write to " +
                "GitHub; linked items are updated instead of duplicated.",
            intent: "export pm items as GitHub issues",
            examples: [
                "pm github export --repo unbraind/pm-cli",
                "pm github export --repo unbraind/pm-cli --dry-run",
                "pm github export --repo unbraind/pm-cli --apply",
                "pm github export --label-map bug=kind/bug,enhancement=kind/enhancement",
                "pm github export --ids pm-1,pm-2 --repo unbraind/pm-cli --dry-run",
            ],
            flags: EXPORT_FLAGS,
            failure_hints: [
                "Export is dry-run by default; pass --apply --repo <owner/repo> to write.",
                "--apply requires a GitHub token (GITHUB_TOKEN/GH_TOKEN or `gh auth login`).",
                "--label-map takes from=to pairs, e.g. --label-map bug=kind/bug,enhancement=kind/enhancement.",
                "Use --ids <pm-1,pm-2> to scope export; unknown IDs fail fast.",
            ],
        });
        // -----------------------------------------------------------------------
        // search — reach GitHub from `pm search` for imported items.
        // Guarded by a capability check so it is a no-op on runtimes that predate
        // search providers. The provider asks GitHub which issues in the configured
        // repo match the query, then returns hits for the LOCAL pm items imported
        // from those issues (the runtime drops hits that aren't local documents).
        // Activates in semantic/hybrid mode: `pm search "<q>" --semantic`.
        // -----------------------------------------------------------------------
        if (typeof api.registerSearchProvider === "function") {
            api.registerSearchProvider({
                name: "github",
                async query(qctx) {
                    const repo = resolveSearchRepo(qctx.options || {});
                    if (!repo)
                        return [];
                    const token = resolveGitHubToken();
                    let matchedNumbers;
                    try {
                        const { body } = await fetchJSON(buildSearchUrl(repo, qctx.query), token);
                        const parsed = JSON.parse(body);
                        matchedNumbers = (parsed.items ?? [])
                            .map((i) => i.number)
                            .filter((n) => typeof n === "number");
                    }
                    catch {
                        // Network/parse failure → no remote hits; pm degrades to keyword.
                        return [];
                    }
                    // Map remote matches back to local items via provenance tags. Prefer
                    // the runtime-provided documents (already the current corpus); fall
                    // back to a fresh read if absent.
                    const docs = resolveSearchCorpus(qctx.documents, qctx.pm_root);
                    const index = indexByProvenance(docs);
                    return mapSearchHits(matchedNumbers, repo, index);
                },
            });
        }
        // -----------------------------------------------------------------------
        // hooks — actionable sync reminder for github-linked items.
        // Safe + no network: only emits a hint, gated on PM_GITHUB_SYNC, and names
        // the exact command to run. Triggers only when a github-linked item (one
        // carrying a `gh:owner/repo#N` provenance tag) is closed/reopened.
        // -----------------------------------------------------------------------
        api.hooks.afterCommand((ctx) => {
            if (!process.env.PM_GITHUB_SYNC)
                return;
            if (!ctx.ok)
                return;
            if (ctx.command !== "close" && ctx.command !== "update")
                return;
            // Only nudge for items that are actually linked to GitHub.
            const id = ctx.args?.[0];
            if (!id || !ctx.pm_root)
                return;
            const res = spawnSync("pm", ["--path", ctx.pm_root, "--json", "show", id], { encoding: "utf-8", maxBuffer: pmJsonMaxBuffer() });
            if (res.status !== 0)
                return;
            let repo;
            try {
                const item = JSON.parse(res.stdout);
                for (const tag of item?.tags ?? []) {
                    const p = parseProvenanceTag(String(tag));
                    if (p) {
                        repo = p.repo;
                        break;
                    }
                }
            }
            catch {
                return;
            }
            if (!repo)
                return;
            console.error(`[pm-github] ${id} is linked to ${repo}; run \`pm github sync --repo ${repo}\` ` +
                "to push this status change upstream (or --dry-run to preview).");
        });
        // -----------------------------------------------------------------------
        // command — `pm github sync` (push pm status → GitHub close/reopen)
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "github sync",
            description: "Push pm item status changes back to GitHub: close/reopen the linked " +
                "issue (matched by the `gh:owner/repo#N` provenance tag) to match the pm " +
                "item's status. Requires a GitHub token and explicit --repo. Use --dry-run " +
                "to preview the plan without mutating anything.",
            intent: "sync pm item status to the linked GitHub issue state",
            examples: [
                "pm github sync --repo unbraind/pm-cli --dry-run",
                "pm github sync --repo unbraind/pm-cli --ids pm-123,pm-456 --dry-run",
                "pm github sync --repo unbraind/pm-cli",
            ],
            flags: SYNC_FLAGS,
            failure_hints: [
                "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` (sync mutates remote issues).",
                "Pass --repo <owner/repo> explicitly; sync never guesses the target repo.",
                "Use --ids <pm-1,pm-2> to scope sync; unknown IDs fail fast to avoid silent misses.",
                "Items must carry a `gh:owner/repo#N` tag — import with `pm github import` first.",
                "Use --dry-run to preview the close/reopen plan before pushing.",
            ],
            async run(ctx) {
                return runSync(ctx);
            },
        });
        // -----------------------------------------------------------------------
        // command — legacy `pm gh-issues import <owner/repo>` (delegates to core)
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "gh-issues import",
            description: "Fetch GitHub issues from a repo and create/update pm items (idempotent " +
                "on re-import via the `gh:owner/repo#N` provenance tag). Skips pull " +
                "requests by default. Uses GITHUB_TOKEN/GH_TOKEN (or the authenticated " +
                "gh CLI) when available for 5000 req/hr and private repos; falls back to " +
                "the unauthenticated API (60 req/hr). Equivalent to `pm github import`.",
            intent: "import GitHub issues as pm items",
            arguments: [
                { name: "owner/repo", required: true, description: "GitHub repository to import" },
            ],
            examples: [
                "pm gh-issues import unbraind/pm-cli",
                "pm gh-issues import unbraind/pm-cli --all",
                "pm gh-issues import unbraind/pm-cli --labels bug,enhancement",
                "pm gh-issues import unbraind/pm-cli --since 2026-01-01T00:00:00Z",
                "pm github import owner/repo --with-comments",
                "pm github import owner/repo --comments-mode annotations",
                "pm github import owner/repo --atomic",
                "pm github import owner/repo --link-deps",
                "pm github import owner/repo --dry-run",
            ],
            flags: IMPORT_FLAGS,
            failure_hints: [
                "Pass <owner/repo>, e.g. `pm gh-issues import unbraind/pm-cli`.",
                "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` for private repos / 5000 req/hr.",
                "Re-running is safe: existing items are updated, not duplicated.",
                "Use --atomic for a durable resumable journal with reverse compensation on ordinary failures.",
            ],
            async run(ctx) {
                return runImport(ctx.args[0], ctx.pm_root, parseImportOptions(ctx.options));
            },
        });
        // -----------------------------------------------------------------------
        // command — `pm github validate` (diagnostics: gh/token/repo reachability)
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "github validate",
            description: "Diagnose the GitHub integration: whether the `gh` CLI is present, " +
                "whether a token is resolvable (and from where), and—if --repo is " +
                "given—whether that repo is accessible with the resolved token. " +
                "Read-only; never mutates anything. Use --json for machine output.",
            intent: "check gh/token availability and repo accessibility",
            examples: [
                "pm github validate",
                "pm github validate --repo unbraind/pm-cli",
                "pm github validate --repo unbraind/pm-cli --json",
            ],
            flags: VALIDATE_FLAGS,
            failure_hints: [
                "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` to raise the rate limit and reach private repos.",
                "Pass --repo <owner/repo> to verify a specific repo is reachable.",
            ],
            async run(ctx) {
                const report = await runValidate(ctx);
                const jsonMode = ctx.global?.json === true;
                if (!jsonMode) {
                    for (const line of report.messages)
                        console.error(line);
                }
                if (!report.ok) {
                    // Surface a non-zero exit for scripts; the report still returns so
                    // --json consumers get structured detail.
                    throw new CommandError(report.messages.join(" "), report.repo && report.repo_accessible === false ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE);
                }
                return report;
            },
        });
        // -----------------------------------------------------------------------
        // command — `pm github project list <owner>` (discover ProjectsV2)
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "github project list",
            description: "List the GitHub Projects v2 owned by a user or org (number, title, url, " +
                "closed state). Read-only. Use --json for machine output. Needs a token " +
                "with `project`/`read:project` scope for private projects.",
            intent: "discover GitHub Projects v2 for an owner",
            arguments: [{ name: "owner", required: false, description: "GitHub user or org login" }],
            examples: ["pm github project list unbraind", "pm github project list unbraind --json"],
            flags: PROJECT_LIST_FLAGS,
            failure_hints: [
                "Pass an owner login, e.g. `pm github project list unbraind`.",
                "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` (private projects need `project` scope).",
            ],
            async run(ctx) {
                return runProjectList(ctx);
            },
        });
        // -----------------------------------------------------------------------
        // command — `pm github project fields <owner/number>` (introspect schema)
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "github project fields",
            description: "Introspect a GitHub Project v2: its fields and, crucially, the Status " +
                "single-select options that push/pull map pm statuses to. Read-only. Use " +
                "this to design a --status-map. Use --json for machine output.",
            intent: "introspect Project v2 fields and Status options",
            arguments: [{ name: "owner/number", required: false, description: "Project reference, e.g. unbraind/5" }],
            examples: ["pm github project fields unbraind/5", "pm github project fields unbraind/5 --json"],
            flags: PROJECT_FIELDS_FLAGS,
            failure_hints: [
                "Pass <owner/number>, e.g. `pm github project fields unbraind/5`.",
                "A project without a Status field cannot receive pushed statuses (items are still added).",
            ],
            async run(ctx) {
                return runProjectFields(ctx);
            },
        });
        // -----------------------------------------------------------------------
        // command — `pm github project import <owner/number>` (board → pm items)
        // Idempotent via the `gh-project:owner/number#itemId` provenance tag; draft
        // issues import too. Maps the board Status option → pm status.
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "github project import",
            description: "Import every item on a GitHub Project v2 board as pm items (draft issues " +
                "included). Idempotent on re-import via the `gh-project:owner/number#itemId` " +
                "provenance tag; items that wrap a real issue also carry the `gh:repo#N` tag " +
                "so issue- and project-import stay linked. The board's Status option maps to " +
                "the pm status. Safe: --dry-run previews without writing.",
            intent: "import GitHub Project v2 board items as pm items",
            arguments: [{ name: "owner/number", required: false, description: "Project reference, e.g. unbraind/5" }],
            examples: [
                "pm github project import unbraind/5",
                "pm github project import unbraind/5 --dry-run",
                "pm github project import unbraind/5 --status-map in_progress=Doing,closed=Shipped",
            ],
            flags: PROJECT_IMPORT_FLAGS,
            failure_hints: [
                "Pass <owner/number>, e.g. `pm github project import unbraind/5`.",
                "Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` (needs `project`/`read:project`).",
                "Re-running is safe: linked items are updated, not duplicated.",
            ],
            async run(ctx) {
                return runProjectImport(ctx);
            },
        });
        // -----------------------------------------------------------------------
        // command — `pm github project sync <owner/number>` (bidirectional)
        // SAFE BY DEFAULT: previews both directions and writes NOTHING. --apply
        // writes; direction chosen by --push/--pull (default --apply = push).
        // NEVER deletes/archives board items or pm items (no data loss).
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "github project sync",
            description: "Bidirectionally sync pm items and a GitHub Project v2 board. --push adds " +
                "missing pm items to the board (linking existing issues where possible, else " +
                "as draft issues) and sets each item's Status from its pm status. --pull " +
                "updates pm item status from the board. SAFE BY DEFAULT: with no --apply it " +
                "previews both directions and writes nothing. Unmapped statuses are SKIPPED, " +
                "never guessed. Never deletes or archives anything on either side.",
            intent: "bidirectionally sync pm items with a GitHub Project v2 board",
            arguments: [{ name: "owner/number", required: false, description: "Project reference, e.g. unbraind/5" }],
            examples: [
                "pm github project sync unbraind/5",
                "pm github project sync unbraind/5 --push --apply",
                "pm github project sync unbraind/5 --pull --apply",
                "pm github project sync unbraind/5 --push --pull --apply --prefer pm",
                "pm github project sync unbraind/5 --push --apply --ids pm-1,pm-2",
            ],
            flags: PROJECT_SYNC_FLAGS,
            failure_hints: [
                "Preview is default; pass --apply with --push and/or --pull to write.",
                "--apply requires a GitHub token (GITHUB_TOKEN/GH_TOKEN or `gh auth login`).",
                "Design a --status-map with `pm github project fields <owner/number>` first.",
                "Use --ids <pm-1,pm-2> to scope; unknown IDs fail fast.",
            ],
            async run(ctx) {
                return runProjectSync(ctx);
            },
        });
    },
});
//# sourceMappingURL=index.js.map