/** Strict refresh compiler contracts and SDK read-only acceptance. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { resolutionFields, resolutionDigest, STATE_MAP } from "../index.ts";
import { mergeSyncValues, IMPORT_STATE_MAP } from "../sync.ts";
import test from "node:test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient, commitItemMutations } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { advanceSyncBase, baseFields, fieldAtRevision } from "../agreement.ts";
import { localValues, readBase } from "../sync.ts";
import { runRefreshCommand } from "../refresh.ts";
import extension, { AdoClient, compileRefreshPlan, observeRefreshPlan, refreshSaved, RefreshRefusal, validateRefreshInput,
  type AdoConfig, type AdoTransport, type RefreshInput, type RefreshField, type RefreshPlan } from "../index.ts";

const config: AdoConfig = { orgUrl: "https://dev.azure.com/example", project: "Example", token: "synthetic-token" };
const needs: RefreshField[] = ["title", "description", "status", "priority", "tags", "assignee", "ado_area_path", "ado_iteration_path", "relations"];
/** Generate isolated input without sharing mutable arrays. */
function input(count = 1000): RefreshInput {
  return { needs: [...needs], saved: Array.from({ length: count }, (_, index) => ({ id: index + 1, revision: 3, base: [...needs] })),
    observed: Array.from({ length: count }, (_, index) => ({ id: index + 1, revision: 4 })) };
}
/** Require typed refusals, including a useful remedy. */
function refuses(value: unknown, code = "invalid_input") {
  assert.throws(() => compileRefreshPlan(value as RefreshInput), (error) => error instanceof RefreshRefusal && error.code === code && error.remedy.length > 20);
}

test("1000 items cost five reads per phase; every need is accounted and unavailable never means delete", async () => {
  const value = input();
  const calls: Record<string, unknown>[] = [];
  const client = new AdoClient(config, async (_method, _url, body) => {
    const request = JSON.parse(body!) as { ids: number[]; fields: string[] };
    calls.push(request);
    assert.ok(request.ids.length <= 200);
    return { status: 200, body: JSON.stringify({ value: request.ids.map((id) => ({ id, rev: 4, fields: {} })) }) };
  });
  const probe = await client.getWorkItemsReport(value.saved.map((row) => row.id), { fields: ["System.Rev"] });
  assert.equal(calls.length, 5); assert.equal(probe.items.length, 1000);
  const changed = compileRefreshPlan(value);
  for (const batch of changed.hydrate) await client.getWorkItemsReport(batch.ids, { fields: batch.fields, relations: batch.$expand === "relations" });
  assert.equal(calls.length, 10);
  assert.deepEqual(changed.cost, { items: 1000, probe_reads: 5, hydrate_reads: 5, field_cells: 9000, pm_mutations: 0 });
  for (const batch of changed.hydrate) {
    assert.equal(batch.ids.length, 200); assert.equal(batch.fields.length, 9); assert.equal(batch.$expand, "relations");
  }
  for (const count of changed.accounting) assert.deepEqual(count, { field: count.field, cached: 0, read: 1000, unavailable: 0, pending: 0 });
  for (const row of value.observed!) row.revision = 3;
  const unchanged = compileRefreshPlan(value);
  assert.equal(unchanged.hydrate.length, 0); assert.equal(unchanged.unchanged.length, 1000);
  for (const row of value.saved) row.base = ["title"];
  value.observed!.pop();
  const partial = compileRefreshPlan(value);
  assert.deepEqual(partial.unavailable, [1000]);
  assert.ok(partial.hydrate.every((batch) => !batch.fields.includes("System.Title")));
  for (const row of partial.accounting) assert.equal(row.cached + row.read + row.unavailable, 1000);
  assert.equal(partial.cost.pm_mutations, 0);
  const pending = { ...value }; delete pending.observed;
  assert.equal(compileRefreshPlan(pending).phase, "probe");
  const empty = compileRefreshPlan({ saved: [], needs: ["title"] }); assert.equal(empty.cost.items, 0);
});

test("projection is minimal for each 200-item batch and deterministic across orderings and old revision replays", () => {
  const value = input(3); value.needs = ["title", "status"];
  value.saved[0]!.revision = null; value.saved[1]!.base = []; value.observed![1]!.revision = 3;
  value.observed![2]!.revision = 2; // Old inputs must never count as unchanged.
  const plan = compileRefreshPlan(value);
  assert.deepEqual(plan.changed, [1, 3]); assert.deepEqual(plan.unchanged, [2]);
  assert.deepEqual(plan.hydrate, [{ ids: [1, 2, 3], fields: ["System.Rev", "System.State", "System.Title"], errorPolicy: "omit" }]);
  assert.deepEqual(compileRefreshPlan({ ...value, needs: [...value.needs].reverse(), saved: [...value.saved].reverse(), observed: [...value.observed!].reverse() }), plan);
});

test("one strict schema rejects holes, unknown fields, extra keys and extreme numeric values", () => {
  for (const value of [null, [], {}, { needs: ["title"], saved: [], extra: 1 }, { needs: [], saved: [] },
    { needs: ["title", "title"], saved: [] }, { needs: ["unknown"], saved: [] }, { needs: new Array(1), saved: [] },
    { needs: ["title"], saved: new Array(1) }, { needs: ["title"], saved: Array(10001).fill({}) },
    { ...input(1), observed: [null] }, { ...input(1), observed: [{ id: 2, revision: 1 }] },
    { ...input(2), observed: [{ id: 1, revision: 2 }, { id: 1, revision: 2 }] },
    { ...input(1), saved: [{ id: 1, revision: 1, base: ["title"], extra: true }] },
    { ...input(2), saved: [input(1).saved[0], input(1).saved[0]] },
    { ...input(1), observed: new Array(1) }, { ...input(1), saved: [{ id: 1, revision: 1, base: new Array(1) }] }]) refuses(value);
  const sparse = ["title"] as unknown[]; delete sparse[0]; Object.assign(sparse, { extra: "title" });
  refuses({ needs: sparse, saved: [] });
  for (const number of [NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE, 2147483648, 0, -1, 1.5, "1", null]) {
    refuses({ ...input(1), saved: [{ id: number, revision: 1, base: [] }] });
    if (number !== null) refuses({ ...input(1), saved: [{ id: 1, revision: number, base: [] }] });
    refuses({ ...input(1), observed: [{ id: 1, revision: number }] });
    refuses({ ...input(1), maxOutputBytes: number });
  }
  for (const budget of [1023, 1048577]) refuses({ ...input(1), maxOutputBytes: budget });
  validateRefreshInput({ needs: ["title"], saved: [{ id: 2147483647, revision: 2147483647, base: [] }], maxOutputBytes: 1048576 });
  refuses({ ...input(), maxOutputBytes: 1024 }, "output_budget");
  assert.equal(new RefreshRefusal("scope").code, "scope");
});

/** Real SDK workspace outside git, with the extension installed as shipped. */
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ado-refresh-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents/pm");
  const pm = new PmClient({ cwd: root, pmRoot, author: "fixture-agent" }); await pm.run("init", { prefix: "fixture" });
  const installed = join(pmRoot, "extensions/pm-ado"); mkdirSync(installed, { recursive: true });
  cpSync(join(import.meta.dirname, "../dist"), join(installed, "dist"), { recursive: true });
  writeFileSync(join(installed, "manifest.json"), readFileSync(join(import.meta.dirname, "../manifest.json")));
  const fields = [`ado_id=1`, `ado_rev=3`, `ado_org_url=${config.orgUrl}`, `ado_project=${config.project}`];
  const cwd = process.cwd(); process.chdir(root);
  let id: string;
  try { id = (await pm.create({ title: "Public fixture", type: "Task", field: fields })).item.id; } finally { process.chdir(cwd); }
  const calls: Record<string, unknown>[] = [];
  const request: AdoTransport = async (method, url, body) => {
    assert.equal(method, "POST"); assert.match(url, /workitemsbatch/u);
    calls.push(JSON.parse(body!) as Record<string, unknown>);
    return { status: 200, body: JSON.stringify({ value: [{ id: 1, rev: 3, fields: {} }] }) };
  };
  return { pm, pmRoot, root, id, calls, request };
}

test("real no-git SDK tracker stays unchanged, skips foreign records with reasons, and probes only revisions", async (t) => {
  const f = await fixture(t);
  const before = await f.pm.listAllComplete();
  const plan = await observeRefreshPlan(f.pm, config, f.request, ["title"]);
  assert.deepEqual(plan.unchanged, [1]); assert.equal(plan.hydrate.length, 1); // No saved base.
  assert.deepEqual(f.calls, [{ ids: [1], fields: ["System.Rev"], errorPolicy: "omit" }]);
  assert.deepEqual((await f.pm.listAllComplete()).items, before.items);
  const row = before.items[0]!;
  assert.deepEqual(refreshSaved([{ ...row, ado_id: undefined }, { ...row, ado_project: "Foreign" }], config), []);
  const partial = { ...row, ado_rev: undefined };
  assert.equal(refreshSaved([partial], config)[0]!.revision, null);
  const base = { title: row.title, description: "", status: row.status, priority: row.priority, tags: row.tags, assignee: "", ado_area_path: "", ado_iteration_path: "" };
  assert.equal(refreshSaved([{ ...row, ado_sync_base: JSON.stringify(base) }], config)[0]!.base.length, 8);
  const withRelations = { ...row, ado_sync_base: JSON.stringify({ ...base, relations: [] }) };
  assert.equal(refreshSaved([withRelations], config)[0]!.base.length, 9);
  await f.pm.create({ title: "Unlinked fixture", type: "Task" });
  const original = process.cwd(); process.chdir(f.root);
  try { await f.pm.update(f.id, { field: ["ado_project=Foreign"] }); } finally { process.chdir(original); }
  const skipped = await observeRefreshPlan(f.pm, config, f.request, ["title"]);
  assert.deepEqual(skipped.skipped, [{ reason: "unlinked", count: 1 }, { reason: "foreign_scope", count: 1 }]);
  const client = new AdoClient(config, f.request);
  await client.getWorkItemsReport([1], { fields: ["System.Title"], relations: true });
  assert.equal((f.calls.at(-1) as Record<string, unknown>).$expand, "relations");
});

test("CLI registration uses host SDK and returns typed refusals without a git executable", async (t) => {
  const f = await fixture(t);
  const harness = await createExtensionTestHarness(extension, { name: "pm-ado", capabilities: ["commands", "schema", "preflight"] });
  const old = { ...process.env }, cwd = process.cwd(), exit = process.exitCode;
  const fetchBefore = globalThis.fetch;
  try {
    process.chdir(f.root);
    process.env = { ...old, ADO_ORG_URL: config.orgUrl, ADO_PROJECT: config.project, ADO_TOKEN: config.token, PATH: "", GIT_CEILING_DIRECTORIES: tmpdir() };
    /** Exercise the real command transport without contacting a hosted tracker. */
    globalThis.fetch = async () => new Response(JSON.stringify({ value: [{ id: 1, rev: 3, fields: {} }] }), { status: 200 });
    const command = async (options: Record<string, unknown>, sdk = true) => (await harness.runCommand({ command: "ado refresh-plan", pmRoot: sdk ? f.pmRoot : undefined, options })).result as RefreshPlan & { code: string };
    assert.equal((await command({ fields: "title", maxOutputBytes: 65536 })).ok, true);
    assert.equal((await command({ fields: "title", "max-output-bytes": 65536 })).ok, true);
    assert.equal((await command({ fields: "unknown" })).code, "invalid_input");
    assert.equal((await command({ fields: "title" }, false)).code, "configuration");
    assert.equal((await command({})).code, "configuration");
    delete process.env.ADO_TOKEN;
    assert.equal((await command({ fields: "title" })).code, "configuration");
    process.env.ADO_TOKEN = config.token;
    globalThis.fetch = async () => { throw new Error("must not leak"); };
    assert.equal((await command({ fields: "title" })).code, "remote_failure");
    assert.equal(process.exitCode, 2);
  } finally { process.chdir(cwd); process.env = old; process.exitCode = exit; globalThis.fetch = fetchBefore; }
});

test("remote observations and base corruption fail closed without SDK mutations", async (t) => {
  const f = await fixture(t);
  await assert.rejects(observeRefreshPlan(f.pm, config, async () => ({ status: 200, body: JSON.stringify({ value: [{ id: 999, rev: 1 }] }) }), ["title"]), RefreshRefusal);
  await assert.rejects(observeRefreshPlan(f.pm, config, async () => { throw new Error("private"); }, ["title"]), (error) => error instanceof RefreshRefusal && error.code === "remote_failure");
  const original = process.cwd(); process.chdir(f.root);
  try { await f.pm.update(f.id, { field: ["ado_sync_base=invalid"] }); } finally { process.chdir(original); }
  await assert.rejects(observeRefreshPlan(f.pm, config, f.request, ["title"]), RefreshRefusal);
});

test("500 seeded refresh sequences model field accounting, older observations, omissions and bounded output numbers", async (t) => {
  const f = await fixture(t);
  const before = (await f.pm.listAllComplete()).items;
  let seed = 0x104525;
  /** Deterministic choices also exercise empty bases and extreme int32 revisions. */
  const random = (bound: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % bound; };
  for (let sequence = 0; sequence < 500; sequence++) {
    const value = input(1 + random(30));
    value.needs = needs.filter(() => random(3) !== 0); if (!value.needs.length) value.needs = ["title"];
    value.maxOutputBytes = 1048576;
    const reference = new Map<number, { same: boolean; available: boolean; base: RefreshField[] }>();
    value.observed = [];
    for (const row of value.saved) {
      row.base = needs.filter(() => random(2) === 0);
      row.revision = random(3) === 0 ? null : 2147483647;
      const available = random(4) !== 0, revision = random(2) ? 2147483647 : 1;
      if (available) value.observed.push({ id: row.id, revision });
      reference.set(row.id, { same: row.revision === revision, available, base: row.base });
    }
    for (let step = 0; step < 3; step++) {
      const plan = compileRefreshPlan(value);
      for (const row of plan.accounting) {
        const states = [...reference.values()];
        assert.equal(row.cached, states.filter((state) => state.available && state.same && state.base.includes(row.field)).length);
        assert.equal(row.unavailable, states.filter((state) => !state.available).length);
        assert.equal(row.read, states.filter((state) => state.available && (!state.same || !state.base.includes(row.field))).length);
        assert.equal(row.cached + row.read + row.unavailable, value.saved.length);
      }
      assert.ok(plan.probe.length <= Math.ceil(value.saved.length / 200));
      assert.ok(plan.hydrate.length <= Math.ceil(value.saved.length / 200));
      const json: unknown = JSON.parse(JSON.stringify(plan));
      /** Check emitted numbers independently of the compiler's numeric guard. */
      const check = (entry: unknown): void => {
        if (typeof entry === "number") assert.ok(Number.isInteger(entry) && entry >= 0 && entry <= 2147483647);
        else if (entry !== null && typeof entry === "object") for (const nested of Object.values(entry)) check(nested);
      };
      check(json);
      value.saved.reverse(); value.observed!.reverse(); value.needs.reverse();
    }
    assert.deepEqual((await f.pm.listAllComplete()).items, before, `seed ${seed}: compiler cannot mutate SDK state`);
  }
});

test("peer edits injected at every async boundary use current SDK revision/base and never overwrite peer state", async (t) => {
  const f = await fixture(t);
  for (const boundary of [0, 1, 2, 3, 4, 5]) {
    let step = 0;
    const cwd = process.cwd(); process.chdir(f.root);
    try { await f.pm.update(f.id, { field: ["ado_rev=3"], title: "Before peer" }); } finally { process.chdir(cwd); }
    /** Real competing transition; wrappers always delegate to the real SDK. */
    const inject = async () => {
      if (step++ !== boundary) return;
      const original = process.cwd(); process.chdir(f.root);
      try { await f.pm.update(f.id, { title: "Peer success", field: ["ado_rev=4"] }); } finally { process.chdir(original); }
    };
    const reader = { listAllComplete: async () => { await inject(); const result = await f.pm.listAllComplete(); await inject(); return result; } };
    const request: AdoTransport = async (...args) => { await inject(); const response = await f.request(...args); await inject(); return response; };
    const plan = await observeRefreshPlan(reader, config, request, ["title"]);
    const current = (await f.pm.get(f.id)).item;
    assert.equal(current.title, "Peer success"); assert.equal(current.ado_rev, 4);
    // A peer transition after the final snapshot remains outside the observation's point in time.
    assert.equal(plan.unchanged.length, boundary === 5 ? 1 : 0);
    assert.equal(plan.cost.pm_mutations, 0);
  }
});

test("identity drift, malformed batch envelopes and whole-receipt budgets refuse before an unsafe observation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(observeRefreshPlan(f.pm, config, async () => ({ status: 200, body: "{}" }), ["title"]), RefreshRefusal);
  let reads = 0;
  const reader = { listAllComplete: async () => {
    if (++reads === 2) {
      const cwd = process.cwd(); process.chdir(f.root);
      try { await f.pm.update(f.id, { field: ["ado_id=2"] }); } finally { process.chdir(cwd); }
    }
    return f.pm.listAllComplete();
  } };
  await assert.rejects(observeRefreshPlan(reader, config, f.request, ["title"]), (error) => error instanceof RefreshRefusal && error.code === "scope");
  const cwd = process.cwd(); process.chdir(f.root);
  try {
    await f.pm.update(f.id, { field: ["ado_id=1"] });
    await f.pm.create({ title: "Second linked fixture", type: "Task", field: ["ado_id=2", "ado_rev=3", `ado_org_url=${config.orgUrl}`, `ado_project=${config.project}`] });
  } finally { process.chdir(cwd); }
  const all = refreshSaved((await f.pm.listAllComplete()).items, config);
  const request: AdoTransport = async () => ({ status: 200, body: JSON.stringify({ value: [{ id: 1, rev: 3 }, { id: 2, rev: 3 }] }) });
  assert.equal((await observeRefreshPlan(f.pm, config, request, ["title"])).unchanged.length, 2);
  const preSkip = compileRefreshPlan({ saved: all, needs, observed: all.map((row) => ({ id: row.id, revision: 3 })) });
  const budget = Buffer.byteLength(JSON.stringify(preSkip));
  assert.ok(budget >= 1024);
  await assert.rejects(observeRefreshPlan(f.pm, config, request, needs, budget), (error) => error instanceof RefreshRefusal && error.code === "output_budget");
});

test("unexpected host context failure is sanitized as a typed command refusal", async () => {
  const exit = process.exitCode;
  try {
    const result = await runRefreshCommand({} as Parameters<typeof runRefreshCommand>[0]);
    assert.equal(result.ok, false); assert.equal("code" in result && result.code, "remote_failure");
  } finally { process.exitCode = exit; }
});


test("round-6 matching revision never caches a legacy partial base with no field set", async (t) => {
  const f = await fixture(t), cwd = process.cwd(); process.chdir(f.root);
  try { await f.pm.update(f.id, { field: ['ado_sync_base={"ado_base_partial":1,"relations":[]}'] }); }
  finally { process.chdir(cwd); }
  const before = (await f.pm.listAllComplete()).items;
  const plan = await observeRefreshPlan(f.pm, config, f.request, ["title", "relations"]);
  assert.deepEqual(plan.hydrate, [{ ids: [1], fields: ["System.Rev", "System.Title"], errorPolicy: "omit", $expand: "relations" }]);
  assert.ok(plan.accounting.every((row) => row.cached === 0 && row.read === 1));
  assert.deepEqual((await f.pm.listAllComplete()).items, before);
  process.chdir(f.root);
  try {
    await f.pm.create({ title: "Missing organization", type: "Task", field: ["ado_id=2", `ado_project=${config.project}`] });
    await f.pm.create({ title: "Missing project", type: "Task", field: ["ado_id=3", `ado_org_url=${config.orgUrl}`] });
  } finally { process.chdir(cwd); }
  const skipped = await observeRefreshPlan(f.pm, config, f.request, ["title"]);
  assert.equal(skipped.skipped!.find((row) => row.reason === "foreign_scope")!.count, 2);
  assert.equal(skipped.accounting[0]!.read, 1);
});


test("round-6 random persisted field sets and revisions hydrate exactly the missing requested fields", async (t) => {
  const f = await fixture(t), item = (await f.pm.listAllComplete()).items[0]!;
  const values = { ...localValues(item, false), relations: [] };
  let seed = 0x6a27cafe, cases = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let step = 0; step < 2048; step++) {
    const present = needs.filter(() => ((random() >>> 16) & 1) !== 0), requested = needs.filter(() => ((random() >>> 16) & 1) !== 0);
    if (!requested.length) requested.push(needs[step % needs.length]!);
    const revision = 1 + random() % 5, observed = 1 + random() % 5;
    const revisions = Object.fromEntries(present.filter(() => random() % 3 !== 0).map((key) => [key, 1 + random() % 5]));
    const legacy = step % 7 === 0, dated = step % 3 !== 0;
    // Unlisted physical values must never manufacture presence.
    const physical = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, (legacy || !present.includes(key as RefreshField)) && step % 5 === 0 ? 7 : value]));
    const base = { ...physical, ado_base_partial: 1, ...(legacy ? {} : { ado_base_fields: present }), ...(dated ? { ado_agreed_revisions: JSON.stringify(revisions) } : {}) };
    const saved = refreshSaved([{ ...item, ado_rev: revision, ado_sync_base: JSON.stringify(base) }], config);
    const plan = compileRefreshPlan({ saved, needs: requested, observed: [{ id: 1, revision: observed }] });
    const missing = requested.filter((key) => legacy || observed < revision || !present.includes(key) || (dated ? revisions[key] !== observed : revision !== observed));
    assert.deepEqual(plan.hydrate, missing.length ? [{ ids: [1], fields: ["System.Rev", ...missing.filter((key) => key !== "relations").map((key) => ({ title: "System.Title", description: "System.Description", status: "System.State", priority: "Microsoft.VSTS.Common.Priority", tags: "System.Tags", assignee: "System.AssignedTo", ado_area_path: "System.AreaPath", ado_iteration_path: "System.IterationPath" })[key]).sort()], errorPolicy: "omit", ...(missing.includes("relations") ? { $expand: "relations" } : {}) }] : []);
    for (const row of plan.accounting) assert.equal(row.read, Number(missing.includes(row.field)));
    for (const row of plan.accounting) assert.equal(row.cached, Number(!missing.includes(row.field)));
    const reversed = { ...base, ...(legacy ? {} : { ado_base_fields: [...present].reverse() }) };
    assert.deepEqual(refreshSaved([{ ...item, ado_rev: revision, ado_sync_base: JSON.stringify(reversed) }], config), saved);
    cases++;
  }
  assert.equal(cases, 2048); t.diagnostic("seed 0x6a27cafe: 2048 presence/request/revision cases, including legacy unknown sets and stale per-key witnesses");
  for (const raw of ["{", "null", "[]", '{"title":0}']) {
    const saved = refreshSaved([{ ...item, ado_sync_base: JSON.stringify({ ...values, ado_base_fields: ["title"], ado_agreed_revisions: raw }) }], config);
    assert.equal(compileRefreshPlan({ saved, needs: ["title"], observed: [{ id: 1, revision: 3 }] }).accounting[0]!.read, 1);
  }
  for (const revisions of [null, [], { title: 0 }, { constructor: 3 }]) refuses({ saved: [{ id: 1, revision: 3, base: ["title"], revisions }], observed: [{ id: 1, revision: 3 }], needs: ["title"] });
  assert.equal(fieldAtRevision("title", ["title"], 3, 3, {}), false);
  assert.equal(fieldAtRevision("title", ["title"], 4, 3, { title: 3 }), false);
  assert.equal(fieldAtRevision("constructor", ["constructor"], 3, 3, {}), false);
  assert.deepEqual(baseFields({ ado_base_fields: ["missing", "title", "title", 7], title: "known" } as unknown as ReturnType<typeof localValues>), ["title"]);
  assert.deepEqual(baseFields({ ado_base_partial: 1, title: "old", ado_base_fields: "malformed" }), []);
  assert.deepEqual(baseFields({ ado_base_fields: ["relations"], relations: "malformed" }), []);
  assert.deepEqual(baseFields({ ado_base_fields: ["relations"], relations: [7] } as unknown as ReturnType<typeof localValues>), []);
});

test("round-6 native agreement publication persists the exact field set consumed by refresh", async (t) => {
  const f = await fixture(t); let previous: ReturnType<typeof readBase>;
  for (let step = 0; step < 18; step++) {
    const item = (await f.pm.listAllComplete()).items[0]!, values = { ...localValues(item, false), relations: [] };
    const observed = 4 + step, equal = needs.filter((_key, index) => (step + index) % 3 === 0);
    const remote = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, equal.includes(key as RefreshField) ? value : Array.isArray(value) ? ["different"] : typeof value === "number" ? 4 : "different"]));
    const result = await advanceSyncBase({ expectedVersion: item.updated_at, minimumRemoteRevision: 1,
      readLocal: async () => ({ version: item.updated_at, values, base: previous, acknowledgedRevision: Number(item.ado_rev) }),
      readRemote: async () => ({ values: remote, revision: observed }),
      publish: async (base, revision, version) => {
        await commitItemMutations({ pmRoot: f.pmRoot, author: "fixture-agent", transactionId: `presence-${step}`, mutations: [{ op: "update", id: item.id, match: { key: "updated_at", value: version }, options: { field: [`ado_sync_base=${JSON.stringify(base)}`, ...(revision === undefined ? [] : [`ado_rev=${revision}`])] } }] });
      } });
    const persisted = (await f.pm.listAllComplete()).items[0]!;
    assert.deepEqual(JSON.parse(String(persisted.ado_sync_base)).ado_base_fields, [...new Set([...baseFields(previous), ...equal])].sort());
    const plan = compileRefreshPlan({ saved: refreshSaved([persisted], config), needs, observed: [{ id: 1, revision: observed }] });
    for (const row of plan.accounting) assert.equal(row.cached, Number(equal.includes(row.field)));
    previous = result.base;
  }
});


test("round-6 SDK and copied CLI JSON TOON read-back share exact base presence", async (t) => {
  const f = await fixture(t);
  const run = promisify(execFile), cwd = process.cwd();
  const values = { ...localValues((await f.pm.listAllComplete()).items[0]!, false), relations: [] };
  const remote = { id: 1, rev: 3, fields: { "System.State": "New", "System.Title": "Remote" }, relations: [] };
  for (const declared of [undefined, [], ["title"]]) {
    const base = { ...values, title: "Remote", ado_base_partial: 1, ...(declared === undefined ? {} : { ado_base_fields: declared }) };
    const item = { ...(await f.pm.listAllComplete()).items[0]!, ado_sync_base: JSON.stringify(base) };
    const fields = resolutionFields(item, remote, { imports: IMPORT_STATE_MAP, exports: STATE_MAP });
    assert.equal(fields.find((row) => row.field === "title")!.base, declared?.length ? resolutionDigest("Remote") : null);
    assert.equal(mergeSyncValues({ title: "Local" }, { title: "Remote" }, base).title, declared?.length ? "local" : "conflict");
  }
  process.chdir(f.root);
  try { await f.pm.update(f.id, { field: [`ado_sync_base=${JSON.stringify({ ...values, ado_base_partial: 1, ado_base_fields: ["status"], ado_agreed_revisions: '{"status":3,"title":3}' })}`] }); }
  finally { process.chdir(cwd); }
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ value: [{ id: 1, rev: 3, fields: {} }] })); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const org = `http://127.0.0.1:${address.port}/example`;
  process.chdir(f.root); try { await f.pm.update(f.id, { field: [`ado_org_url=${org}`] }); } finally { process.chdir(cwd); }
  const before = (await f.pm.listAllComplete()).items;
  const bin = join(f.root, "no-git-bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  const env = { ...process.env, PATH: bin, ADO_ORG_URL: org, ADO_PROJECT: "Example", ADO_TOKEN: "synthetic-token", PM_AUTHOR: "fixture-agent", PM_NO_UPDATE_CHECK: "1", GIT_CEILING_DIRECTORIES: tmpdir() };
  const cli = resolve(import.meta.dirname, "../node_modules/@unbrained/pm-cli/dist/cli.js");
  const args = [cli, "--pm-path", f.pmRoot, "ado", "refresh-plan", "--fields", "title,status,relations"];
  const json = JSON.parse((await run(process.execPath, [...args, "--json"], { cwd: f.root, env })).stdout) as RefreshPlan;
  assert.deepEqual(json.accounting.find((row) => row.field === "title"), { field: "title", cached: 0, read: 1, unavailable: 0, pending: 0 });
  assert.equal(json.accounting.find((row) => row.field === "status")!.cached, 1);
  assert.equal(json.accounting.find((row) => row.field === "relations")!.read, 1);
  const toon = (await run(process.execPath, [...args, "--output-format", "toon"], { cwd: f.root, env })).stdout;
  assert.match(toon, /title,0,1,0,0/u); assert.match(toon, /status,1,0,0,0/u);
  assert.deepEqual((await f.pm.listAllComplete()).items, before);
});
