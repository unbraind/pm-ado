/** Independent ordinary SDK writer; no inherited revision scope or SDK substitutions. */
import * as sdk from "@unbrained/pm-cli/sdk";

const [pmRoot, id, raw, mode] = process.argv.slice(2);
const options = JSON.parse(raw) as sdk.PmUpdateActionOptions;
if (mode === "document") {
  // Legacy unjournalled storage fixture, written using the SDK's serialization contract.
  const settings = await sdk.readSettings(pmRoot);
  const located = await sdk.locateItem(pmRoot, id, settings.id_prefix, settings.item_format);
  const { document } = await sdk.readLocatedItem(located!, { schema: settings.schema });
  document.body = String(options.body);
  await sdk.writeFileAtomic(located!.itemPath, sdk.serializeItemDocument(document, { schema: settings.schema }));
} else {
  const pm = new sdk.PmClient({ pmRoot, author: "peer-agent", noExtensions: true });
  await pm.update(id, options);
}
