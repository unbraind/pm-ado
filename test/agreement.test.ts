/** Per-key read-back agreement contracts, with independent stores and an explicit publication boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { advanceSyncBase, readBaseRevisions, type AgreementOperations, type LocalAgreementRead } from "../agreement.ts";
import { mergeSyncValues, readBase, recoveredField } from "../sync.ts";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";

test("agreement advances only actual equal keys and acknowledges revisions only on complete agreement", async () => {
  const prior = { title: "old", description: "", relations: [] };
  let local: LocalAgreementRead = { values: { title: "same", description: "local", relations: [] }, version: "v1", base: prior };
  let remote = { values: { title: "same", description: "remote", relations: ["new link"] }, revision: 2 };
  const publications: unknown[] = [];
  const operations: AgreementOperations = { expectedVersion: "v1", minimumRemoteRevision: 1,
    readLocal: async () => local, readRemote: async () => remote,
    publish: async (...args) => { publications.push(args); } };
  const partial = await advanceSyncBase(operations);
  assert.deepEqual(partial.base, { title: "same", description: "", relations: [], ado_agreed_revisions: JSON.stringify({ title: 2 }) });
  assert.deepEqual(partial.differences, ["description", "relations"]);
  assert.deepEqual(publications[0], [partial.base, undefined, "v1"]);
  local = { ...local, base: undefined };
  assert.deepEqual((await advanceSyncBase(operations)).base, { title: "same", ado_base_partial: 1, ado_agreed_revisions: JSON.stringify({ title: 2 }) });
  remote = { values: structuredClone(local.values) as typeof remote.values, revision: 3 };
  const full = await advanceSyncBase(operations);
  assert.deepEqual(full.base, { ...local.values, ado_agreed_revisions: JSON.stringify({ title: 3, description: 3, relations: 3 }) });
  assert.deepEqual(publications.at(-1), [full.base, 3, "v1"]);
  local = { ...local, version: "peer edit" };
  await assert.rejects(advanceSyncBase(operations), /Local item changed/u);
  assert.equal(publications.length, 3);
  local = { ...local, version: "v1", acknowledgedRevision: 4 };
  await assert.rejects(advanceSyncBase(operations), /older/u);
  local = { ...local, acknowledgedRevision: undefined };
  for (const revision of [0, 1.5]) {
    remote.revision = revision;
    await assert.rejects(advanceSyncBase(operations), /older/u);
  }
  assert.equal(publications.length, 3);
});

test("partial agreement decoding retains unknown keys without accepting malformed present values", () => {
  const item = { id: "synthetic", ado_sync_base: JSON.stringify({ title: "agreed", ado_base_partial: 1 }) } as unknown as ItemMetadata;
  assert.deepEqual(readBase(item, { title: "", relations: [], priority: 2 }), { title: "agreed", ado_base_partial: 1 });
  assert.throws(() => readBase({ ...item, ado_sync_base: JSON.stringify({ title: 7, ado_base_partial: 1 }) }, { title: "" }), /title/u);
});

test("owned scalar effect proof never becomes a base for unrelated fields or relations", () => {
  const effect = { original: { title: "before" }, accepted: { title: "sent", relations: ["remote link"] }, keys: ["title", "relations"], revision: 1 };
  assert.deepEqual(mergeSyncValues({ title: "sent", relations: [] }, { title: "sent", relations: ["remote link"] }, { title: "before", relations: [] }, effect), { title: "equal", relations: "remote" });
  assert.deepEqual(mergeSyncValues({ title: "new local" }, { title: "sent" }, { title: "before" }, effect), { title: "local" });
  assert.deepEqual(mergeSyncValues({ title: "before" }, { title: "sent" }, { title: "before" }, effect), { title: "remote" });
  assert.deepEqual(mergeSyncValues({ title: "other local" }, { title: "other remote" }, { title: "before" }, effect), { title: "conflict" });
  assert.deepEqual(mergeSyncValues({ title: "before" }, { title: "other remote" }, undefined, effect), { title: "remote" });
  assert.deepEqual(mergeSyncValues({ title: "local" }, { title: "before" }, { title: "before" }), { title: "local" });
  assert.deepEqual(mergeSyncValues({ title: "local" }, { title: "remote" }, undefined), { title: "conflict" });
  assert.equal(recoveredField("same", "sent", "same", "sent"), "remote");
  assert.deepEqual(mergeSyncValues({ description: "local" }, { description: "remote" }, { description: "before" }, effect), { description: "conflict" });
});


test("per-key revision witnesses retire old proof even when another key still prevents full acknowledgement", async () => {
  const old = { title: "accepted", relations: [], ado_agreed_revisions: JSON.stringify({ title: 2, relations: 1 }) };
  const result = await advanceSyncBase({ expectedVersion: "v", minimumRemoteRevision: 1,
    readLocal: async () => ({ version: "v", values: { title: "local", relations: [] }, base: old }),
    readRemote: async () => ({ revision: 3, values: { title: "remote", relations: ["new"] } }), publish: async () => {} });
  assert.deepEqual(readBaseRevisions(result.base), { title: 2, relations: 1 });
  assert.deepEqual(mergeSyncValues({ title: "original" }, { title: "new remote" }, old,
    { original: { title: "original" }, accepted: { title: "accepted" }, keys: ["title"], revision: 1 }), { title: "conflict" });
  assert.deepEqual(readBaseRevisions(undefined), {});
  for (const raw of ["{", "null", "[]", "7", '{"title":0}', '{"title":1.5}']) assert.throws(() => readBaseRevisions({ ado_agreed_revisions: raw }), /agreement revisions/u);
});
