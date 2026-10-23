# Azure revision response fixtures

`revision-2.json` records a synthetic, fully hydrated Azure DevOps Work Item
Tracking REST **7.1** revision response. It is shaped like the documented
[Revisions – Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/revisions/get?view=azure-devops-rest-7.1)
response (`id`, `rev`, `fields`, optional `relations`, `_links`, `url`). Names,
identities and values are synthetic. This is a contract fixture, not a capture
from a credentialed service. Tests use the same hydrated shape for the existing
work-items batch reader; no revisions-feed reconciliation is introduced.

The fixture server applies whole JSON Patch documents only after their leading
`test /rev` succeeds, following
[Work Items – Update, REST 7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1).
A 412 race never applies the field operations. This verifies the adapter's REST
contract; it does not establish live permissions or organization process rules.
