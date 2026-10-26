# Marketplace packages

Marketplace packages add third-party specialist agents. Package data is stored
locally and selected in the active preset; installing a package does not add it
to the running agent registry. Registry membership and permissions are frozen
for each plugin generation.

## CLI

Run commands from the project directory. Bundle paths are resolved relative to
the current working directory.

```sh
oh-my-opencode-slim marketplace install author/package
oh-my-opencode-slim marketplace import ./package.json
oh-my-opencode-slim marketplace list
oh-my-opencode-slim marketplace show author/package
oh-my-opencode-slim marketplace verify [author/package]
oh-my-opencode-slim marketplace enable author/package [--user]
oh-my-opencode-slim marketplace disable author/package [--user]
oh-my-opencode-slim marketplace update author/package
oh-my-opencode-slim marketplace update-file ./package.json
oh-my-opencode-slim marketplace uninstall author/package --global
oh-my-opencode-slim marketplace status
oh-my-opencode-slim marketplace request-reload
```

Commands reject unknown options, missing targets, and extra arguments. `install`
and `update` use the configured marketplace registry; `import` and
`update-file` read local JSON bundles. `enable`/`disable` persist activation
directives into the active preset. Activation defaults to project scope: it
creates a project config override when needed and never falls back to editing
the shared user config. Pass `--user` to explicitly update the user config and
its active preset. The user config is shared by projects. `disable` only changes
activation and never deletes the shared package. `uninstall <id> --global` is
the only package deletion command; the exact `--global` flag is required. It
removes references from the current project and known user configuration, then
removes the package from the shared store. Other project trees are not scanned,
so they may retain dangling references. The command reports this limitation.
Validation, service, and config failures return a nonzero exit status. A failed
verification also returns nonzero.

When a package exists but requires a newer plugin version, install/update report
the package ID, required plugin version range, and current plugin version rather
than presenting it as missing. The client still falls back from the V3 registry
to V2 when V3 has no compatible release; if V2 also has no installable package,
the V3 incompatibility diagnostic is preserved, including when V2 has entries
but none are compatible. Incompatible installs and updates do not modify the
local package store.

`status` compares installed desired packages with the live registry only when
called inside a running plugin generation. Standalone CLI status reports
`liveAvailable: false`, `livePackages: null`, and `reloadRequired: null`, since
it cannot inspect the host's in-memory agent registry.

## Orchestrator tools

The orchestrator can use `marketplace_inspect` (`list`, `show`, `verify`,
`status`, `request_reload`) and `marketplace_manage` (`install`, `import`,
`update`, `update_file`, `uninstall`, `enable`, `disable`). `uninstall` requires
`acknowledge_other_projects: true` and means global shared-store deletion; its
result warns that other projects are not inspected. Both tools are restricted by
agent permissions and an execution-time orchestrator identity guard that
accounts for a configured orchestrator display alias.
`enable` and `disable` accept optional `scope: project|user`, defaulting to
`project`; other actions reject `scope`.

Management tools mutate desired disk state only. `request_reload` only reports
whether restarting/reloading OpenCode is required; it never reloads the host or
claims that newly configured agents are already available. Restart OpenCode to
create a new plugin generation and agent registry.

## Preset selection

Marketplace activation lives under a preset's `marketplace` block. A root-level
`marketplace` block is the subsystem switch only (`{"enabled": false}`); an
activation list placed at the root is inert. For example:

```jsonc
{
  "preset": "work",
  "presets": {
    "work": {
      "marketplace": {
        "agents_add": ["author/package"],
      },
    },
  },
}
```

Use the CLI `enable`/`disable` commands to update this state safely, including
layered presets. Their default project scope creates a project override; pass
`--user` only to change shared user activation. See
[Marketplace package contract](marketplace-contract.md) for bundle and registry
schemas and [Configuration](configuration.md) for config locations.

## Customize an installed agent

Marketplace packages provide the starting configuration. Once a package is
selected in a preset, customize its agent using the same `agents.<name>`
configuration as a built-in or custom OMOS agent. Use the manifest's runtime
`agentName` (for example, `chronicler`), not the package ID.

```jsonc
{
  "agents": {
    "chronicler": {
      "skills_add": ["writing-auditor", "pretty-mermaid"],
      "mcps": ["context7", "gh_grep", "serena"]
    }
  }
}
```

Without an override, marketplace skills and MCPs retain the package's defaults.
An explicit `skills` or `mcps` list replaces that dimension's defaults;
`[]` denies all. `skills_add`, `skills_remove`, and
`skills_include_local` adjust the package's skill defaults without copying
them into user configuration. Skill grants use native OpenCode skill IDs;
`["*", "!name"]` grants all skills except `name`. MCP selections similarly
accept `*` and `!name`, but only enabled, available MCP servers are selected.
Unknown skills cannot be loaded until the host registers them. A missing
optional user-selected capability does not make package activation fail.
Manifest-declared dependencies still undergo the existing activation checks.

Local skill and MCP selections do **not** expand the marketplace package's
core-tool permissions. Effective native rules can further restrict grants,
and ambiguous MCP namespaces are rejected.

`external_directory` is an OpenCode safety guard, not a manifest tool
capability: a package's `tools` list never grants it, and a manifest tool
grant (for example `read`) never implies it. Owner configuration can declare
it via `agents.<name>.permission.external_directory` — a
whole-tool `allow`/`ask`/`deny` or a path-pattern map. The native guard checks
an external directory boundary, normally ending in `/*`, separately from the
file's `read` or `edit` permission. For example,
`{ "/approved/*": "allow", "/approved/private/*": "deny" }`. Finalized host
permission rules also participate in ordered matching: an applicable host
allow, including a wildcard-action allow, can open the guard, while a later
host deny or ask restricts an owner allow. This order also applies when the
owner explicitly denies the guard: a later host allow or ask overrides that
deny for matching directory boundaries, both at registration and in compiled
child sessions. Directory guard denies are not replayed as package capability
ceilings; tool, Skill, and MCP ceilings remain unchanged. Without an owner
declaration or an applicable host override, the guard stays denied for the
agent and its compiled child sessions.

To customize the agent prompt, use the same global or project-local Markdown
files as other OMOS agents:

```text
.opencode/oh-my-opencode-slim/
├── chronicler.md          # replaces the marketplace prompt
└── chronicler_append.md   # appends after the selected base prompt
```

The prompt precedence is inline `agents.chronicler.prompt`, then
`chronicler.md`, then the assembled marketplace package prompt.
`chronicler_append.md` appends to whichever base wins. Preset-specific files,
ancestor lookup and global fallback follow
[project-local customization](project-local-customization.md#prompt-lookup-precedence).
Prompts and capability policies are captured per plugin generation; restart
OpenCode to apply changes to new sessions.
