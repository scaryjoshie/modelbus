# Runtime, providers, and independent operations

Design record from Joshua's September 9, 2026 discussion with Codex. This is the
current direction for the boundaries below. It supersedes conflicting suggestions
in the earlier conversation and exploratory documents. Proposed interfaces and
unverified host capabilities are identified explicitly; they are not implemented
merely because they appear here. See `architecture.md` for the running code.

## Vocabulary and ownership

| Name | Owns |
|---|---|
| Core | Agent identities, conversations, messages, delivery records, communication invariants |
| Runtime | Client protocol, authentication boundary, provider management, presence, routing, lifecycle |
| Provider | Integration with a host; host-specific discovery, communication, setup, and settings semantics |
| Discovery | Observations about sessions; no registration or setup as a side effect |
| Connector | Communication with host sessions; called through the runtime contract |
| Client | Sends and receives through the runtime protocol; holds credentials outside model context |

The daemon is the process and composition root that wires these components. An
orchestrator, if added, coordinates work or makes policy decisions through runtime
operations. It is not another name for the runtime and is not needed for messaging.

The provider contract belongs to the runtime. Core needs only its narrow delivery
port, currently `Deliver` in `core/api.ts`. Providers do not receive a core API or
store. They may share neutral value types such as a delivery result. The runtime
maps provider keys to bus agent IDs, resolves callers, and invokes core operations.

A provider may group discovery and communication objects for code reuse and
configuration. That grouping does not require either capability to exist, nor does
it require their operations to run together. No base class is necessary. Discovery
is naturally an instance capability when it uses configured accounts or caches;
it need not be a class method or create a session object for every observation.

Keep these concepts distinct as the implementation grows:

- Provider definition: integration code and default metadata.
- Provider instance: a configured installation, account, or connection.
- Agent: one participant on the bus.
- Connection/location: a current route to that participant, such as a process or tab.

These are conceptual distinctions, not a requirement for four new tables/classes.
The current implementation has one instance per `host` namespace; it does not yet
provide a general provider-instance registry. The existing `host` and `hostKey`
wire/database fields remain for compatibility and their keys are not credentials.

## Independent operations, composed by a caller

Discovery, host setup, agent registration, credential attachment, sending a
message, publishing an artifact, and listing a board are separate operations.
None should require an unrelated operation just because a UI may group them.

Examples:

- Register an agent that discovery has never seen.
- Inspect available sessions without connecting them or modifying host settings.
- Configure a host once, then connect selected sessions later.
- Publish a Markdown document without sending anyone a message.
- Send a message referencing an existing document without uploading it again.

A Connect button or orchestrator may compose operations as a convenience. Do not
make a universal onboarding wizard, mandatory prerequisite probe, browser pairing
procedure, or fixed sequence the only way to use the underlying operations.

Discovery describes candidates, not consent or authentication. Joshua expects an
explicit way to connect sessions, with setup varying by host and possibly by
session. A future automatic mode can compose the same operations. The exact UI
and policy remain open.

Current compatibility: the POC runtime still automatically binds discovered
top-level sessions during reconciliation. The extracted `discover(providers)`
operation itself does not bind anything. Replacing that runtime policy requires
a usable explicit connection entry point; this cleanup does not silently remove
existing sessions from the bus.

## Identity and credentials: software remembers the secret

Each agent can independently register with the runtime and receive a permanent ID
and a credential. Subsequent calls authenticate with that credential. A dedicated
provider/client connection can keep the binding automatically; the language model
should not remember a secret or repeat it in tool arguments.

The local MCP shim already determines its identity at startup. It now uses a bound
client, `createClient(identity)`, whose requests attach the identity envelope.
Registration tokens are `<agent-id>.<secret>`; only a hash of the secret is stored
by the daemon. Names and provider keys remain independent of secrets. Rotation can
preserve identity; rotation/revocation APIs and credential expiry are not built.

There are two different web integration paths to investigate:

1. A browser-aware provider holds modelbus credentials and has an explicit binding
   to a particular conversation/tab. It can attach credentials automatically when
   forwarding that conversation's calls, provided it actually has a supported
   communication path. A tab identifier alone is not such a path.
2. A remote MCP server receives calls from the web service. The host handles OAuth
   credentials outside model tool arguments. The server still needs a way to
   distinguish independently registered conversations sharing an account connection.

The unresolved question in the second case is routing context, not whether tokens
can authenticate. If two chats send otherwise identical calls under the same
account credential, the server cannot infer which agent made each call. Possible
solutions include documented conversation metadata, a connection dedicated to one
agent, or a non-secret session reference scoped to the authenticated account. Do
not assume a transport session ID equals a conversation ID, or store one mutable
"current agent" for an entire account. Never solve this by requiring the model to
repeat a secret. Which mechanism each web host actually supports remains open.

Registration need not prove a browser URL. Explicit user binding is an available
workflow; it is not a mandatory ceremony for every registration.

Current gaps: `self` identities are still claims accepted at the local RPC edge.
The provider refactor does not authenticate that path. Claude Code's inbox token
authorizes delivery into Claude Code, independently of modelbus registration
credentials; possessing or attaching it is not automatically modelbus caller proof.
The daemon's existing open roster/log operations are also not a cloud access model.

## Readiness is scoped evidence, and can be unknown

A provider does not necessarily know whether setup is complete. Finding a tab,
binary, config file, or an MCP entry is partial evidence. It does not prove that
the running conversation loaded the tool or can call it.

Two Claude accounts in different browser profiles can have different connectors,
permissions, and policies. Even chats within an account can enable different tools.
Do not cache "Claude is configured" as a machine-wide fact. Any future readiness
report should be scoped to the actual connection/account/session, say what was
checked, and allow unknown. An unperformed or failed probe is not proof of missing
configuration. Successful calls prove only the capabilities they exercised.

This is a design requirement for future setup UX, not a new capability matrix to
persist in core. The current `reachable` flag is a POC delivery hint, not a complete
prerequisite check or guarantee that the recipient model is running.

An instruction such as "join modelbus" can invoke tools already available in the
chat. It cannot itself install a missing MCP integration or grant access to account
settings. A provider-specific setup flow may help, but no implementation exists yet.

## One-off agents and applications supplying many agents

An unrecognized coding agent can register directly through the local protocol. It
does not need to implement a TypeScript provider or be discovered first. Its client
holds the token and uses send/pull. Automatic unsolicited delivery additionally
requires a supported host input path: a background process receiving bytes does
not on its own place those bytes in the model's context. "One-off" need not erase
history; temporary presence, credential lifetime, and history retention are distinct.

An integrated app should be able to establish a named provider instance and supply
multiple agents with stable app-local identifiers. This should be possible through
a runtime protocol without loading third-party TypeScript into the daemon. Its
name/icon identify the app in the UI. Membership in that app must follow an
authenticated registration/delegation relationship, not a freely supplied label.

The protocol for externally hosted providers and delegated agent credentials is
not designed yet. In-process provider code and a remote provider bridge can target
the same semantic runtime boundary, but process separation adds disconnects,
cancellation, retries, and delivery ambiguity. Do not build IPC just for symmetry.

## Browser discovery and web communication

Joshua wants one experience across browsers, without independently managing a
modelbus integration for each browser if practical. Browser access can be shared
infrastructure reused by web providers. A provider recognizes the service's chats;
browser integration enumerates locations and supplies supported access to them.

There is no established universal browser inventory in modelbus. Browser extensions
and browser-specific desktop automation are candidates; neither establishes zero
setup across all browsers/profiles. Investigate Joshua's actual browsers before
choosing a mechanism. Respect the project's existing no-focus/no-click constraints;
permission to refactor the repository is not permission to manipulate live chats.

An open tab is an observation, not necessarily a live/reachable agent. The same
conversation open twice should ideally have two locations and one identity where
the service exposes sufficient account/conversation context. Do not deduplicate
by title alone or pretend uncertain observations have verified identities.

Web MCP tools make deliberate briefing handoff plausible. Unsolicited injection
into an existing web chat is a separate capability, not established by the connector
documentation reviewed. Modelbus may initially support sending, bounded reply
waiting, and explicit retrieval without promising web-chat wakeup.

## Settings, icons, and private state

Provider settings semantics, defaults, and schema belong to the provider. A runtime
UI can use the schema and a generic persistence helper without understanding each
setting. Configuration files are the preferred direction; their exact layout,
schema format, update protocol, and reload behavior are not implemented yet.

Claude's proposed setting controls whether its own session token is captured and
used for delivery. Joshua is willing to persist that token. Persistence/re-attachment,
cleanup, disabling the setting, and resume/rotation behavior need explicit handling;
do not claim resume stability has been tested. Current tokens remain memory-only.

Icons are provider metadata. Built-in providers can bundle assets; external apps
can supply them. The runtime may retain/cache assets and metadata so the UI and
historical conversations can display them after disconnect. Core does not interpret
icon formats or serve images. Asset storage, overrides, and the UI remain future work.

Provider-private secrets are distinct from user-visible settings. Reusing generic
storage plumbing does not transfer semantic ownership to core, and ownership does
not require every provider to implement its own file parser.

## Artifacts and a temporary file board

Motivating example: a web chat writes `briefing.md`, publishes it to a temporary
board, and a coding agent reads/downloads it without relaying the document through
the conversation. The board is a view over shared artifacts, not necessarily a
message stream. Publishing, listing, retrieving, and notifying are independent.

Keep the protocol's content references independent of where bytes live. A runtime
content service could resolve a stable artifact ID from local storage or a remote
store. Core may record shared content references and access relationships without
implementing downloads or understanding storage URLs. This is a proposed boundary,
not a decision to create another service process or a complete storage abstraction.

Distinguish a reference to a mutable external file from an uploaded snapshot. A
local path or private web sandbox path is not a transferred file. Publishing needs
actual bytes, a supported upload, or an accessible source. Sending Markdown to a
publishing tool is a valid first implementation if direct file upload is unavailable.

Candidate minimal metadata: artifact ID, name, media type, byte size, expiration,
and optionally a hash. Scope/access, expiration behavior, local references versus
snapshots, and upload/download capabilities still need a concrete first workflow.
Do not make artifacts public by default or equate an opaque ID with authorization.
Expose locality only where it affects behavior (availability, progress, expiry),
without promising to conceal outages or access differences.

## Message formatting for agents (open)

Joshua added this explicitly to the questions to resolve: whether a dedicated
message formatter is warranted, where it belongs, and which format works best
when presenting messages to agents. No format or implementation change is decided.

Settled 2026-09-09 (Joshua): the transfer is structured; the text can change
later. Core hands `Outbound` (message row + sender row) through `Deliver` and the
runtime passes it to `Connector.deliver` unchanged. Each connector chooses the
host's form and its own receipt marker. The three built-in providers call one
plain function, `util/attribution.ts`, for the current default text; changing the
format is now a change to that function, and a host with richer input can skip it.

Still two presentation paths for the text itself, both unchanged:

- Native deliveries: `[modelbus #<id>] from <name>`, a blank line, the body.
  Providers watch for `#<id>` in transcripts, so the marker has an operational purpose.
- `src/render.ts` renders inbox items and inline replies as `name: text`, with
  continuation lines indented. CLI and MCP use this presentation; the RPC returns
  structured message data and stores the original body without either wrapper.

Questions to resolve:

- Do actual host differences ever warrant an explicit formatter contract beyond
  the shared function? Do not introduce a class or framework by default.
- Which fields does the recipient need: sender, conversation, message ID, reply
  reference, attachment references, or other context? Which can remain metadata?
- Should push, inbox reads, and inline replies use the same text format, or only
  preserve the same information while fitting their different presentation contexts?
- How should sender attribution and message boundaries be expressed without adding
  unnecessary instructions or implying that another agent speaks for the user?
- How should Markdown, code fences, multiline content, and attachment references
  be preserved? How do we avoid confusing body text with envelope metadata?
- Can hosts carry provenance/receipt IDs as native metadata, and what text fallback
  is needed where they cannot? Formatting alone does not authenticate a sender.

Evaluate small candidate formats against concrete examples: a short DM, a code
snippet, several inbox items, an inline reply, and a document handoff. Compare
clarity, context cost, content preservation, and receipt compatibility. Existing
minimal attribution is the baseline, not evidence of a universally best format.

## Scheduling and lifecycle

The runtime owns recurring discovery/reconciliation policy and coordinates shutdown.
Provider operations may need local protocol timeouts, watchers, or keepalives. Every
ongoing activity needs a cancellable owner; a single global timer is not required.
Avoid a general scheduler until actual tasks justify it. Models do not poll.

Current debt: receipt watchers return cleanup functions that providers do not yet
retain; stopping the manager clears its interval but does not drain outstanding
operations. A proper cancellation/shutdown pass needs to cover both before claiming
that all provider work is supervised. This cleanup changes contracts, not lifecycle.

## Questions to work through

This is an index of unresolved work, not a commitment to implement it all at once.
The sections above contain the direction and constraints for each item.

1. Registration and authentication: remove reliance on unverified self claims;
   credential lifetime/revocation, client ownership, and app-supplied agent identity.
2. Independent discovery, setup, and connection operations: explicit connection
   policy and how readiness evidence is scoped without requiring a universal probe.
3. Provider settings and private state: schema, persistence, reload, and Claude
   token capture/use across restarts and resumes.
4. Runtime lifecycle: cancellation, receipt watchers, shutdown, and recurring work.
5. Message formatting: whether a formatter is warranted, its owner, and the best
   agent-facing representation for each delivery context.
6. Provider instances and presentation metadata, including icons and app grouping.
7. Web participation: browser/account/session context, software-held credentials,
   supported communication paths, and optional discovery across browsers.
8. Shared artifacts/file board: independent publish/read operations, references
   versus snapshots, transfer, access, and expiration across local/cloud storage.

## What this pass implements

- `adapters/` becomes `providers/`; `Tracker` becomes runtime `ProviderManager`.
- Runtime owns `Provider`, `Discovery`, `Connector`, and setup/identity contracts.
- Providers expose separate optional discovery and connector objects.
- `discover(providers)` returns observed/failed results independently of registration.
- Layer checks prevent providers importing core API/store or runtime implementation.
- A bound client carries identity automatically for MCP calls.
- Existing host keys, database, RPC methods, setup behavior, and reconciliation's
  automatic binding policy remain compatible. No web/browser integration is installed.

## Documentation evidence (reviewed 2026-09-09)

- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth):
  the host is an OAuth client; the MCP server verifies access tokens per request.
  This establishes credential handling outside tool arguments, not unique chat identity.
- [Claude connector authentication](https://claude.com/docs/connectors/building/authentication):
  documents connection authentication options. It does not establish that every
  conversation has a separate modelbus-compatible credential or routing identifier.
- [ChatGPT connection setup](https://developers.openai.com/plugins/deploy/connect-chatgpt):
  MCP endpoints can use public HTTPS or Secure MCP Tunnel, subject to account/policy.
- [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp):
  connection setup and per-conversation enablement are separate; remote calls
  originate from Anthropic infrastructure. Recheck deployment options before building.
- [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
  and [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging):
  supported tab observation and extension-to-local-app communication; not proof of
  a browser-independent session inventory or permission to access other profiles.

These sources establish possibilities, not successful modelbus integrations. Web
session isolation, account switching, tab duplication, reconnect, and document upload
require small experiments before choosing a provider implementation.
