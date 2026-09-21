English | [简体中文](./README.md)

# THCLI

The command-line interface for Tencent Cloud TokenHub — the large model service platform. Query models, manage API keys, run inference, monitor usage, and troubleshoot — all from a single command.

THCLI also ships with a set of **Agent Skills** that let local AI agents such as Claude Code drive `thcli` in natural language. Skills are pulled on demand from a remote source — they are not bundled in the npm package and can iterate independently of CLI releases.

```shell
npm i -g tencent-tokenhub-cli
```

Two equivalent commands are available after installation: `thcli` and its short alias `th`. Examples in this document use `thcli`; substituting `th` works exactly the same — for example, `th models list` = `thcli models list`.

## Install via AI Agent

Copy the prompt below to your AI agent (Claude Code, Codex, Trae, etc.) and it will complete the installation for you:

```
Help me install THCLI by following this guide: https://gz-thcli-skills-1258344699.cos.ap-guangzhou.myqcloud.com/tokenhub-cli-skills/install.md
```

The agent reads the guide and completes CLI installation, login, and Skills injection. After that, you can drive `thcli` in natural language.

Injected skills perform **read-only operations** only (queries, diagnostics, and conversations). For write commands such as create / update / delete, the agent only shows you the command and never runs it on your behalf.

## Quick Start

```shell
# 1. Log in (browser OAuth; automatically provisions an API key for conversations)
thcli auth login

# 2. See what models are available
thcli models list

# 3. Chat (--model takes the endpoint ID directly)
thcli +chat --model hy3 "Hello"

# 4. Pull Skills and inject them into your local agent
thcli +connect         # downloads skills and injects them into the local agent
```

For headless environments (remote dev machines, CI, containers), use `--browser no` and paste the credential string shown on the web page back into the terminal:

```shell
thcli auth login --browser no
```

## Commands

| Command group | Description |
|---|---|
| `auth` | Log in, log out, enter permanent keys manually, check login status |
| `models` | Model catalog: list, details, side-by-side comparison |
| `endpoint` | Inference endpoints: list, details, reconfiguration, deletion |
| `deploy` | Create an inference endpoint for a model |
| `+chat` | Chat with a model (the only command that invokes the inference API) |
| `chat-config` | Manage the API key used for conversations locally |
| `key` | API keys: create, update, list, enable/disable, reveal |
| `plan` | Plans (Token Plan): purchase, renewal, dedicated keys, usage |
| `usage` | Usage analytics: rankings, charts, CSV export |
| `monitor` | Service health: request volume, error rate, latency, non-text model output |
| `doctor` | Diagnostics: end-to-end health check and targeted troubleshooting (read-only) |
| `profile` | Switch between multiple account identities |
| `site` | Site: China `cn` / International `intl` |
| `lang` | UI language (`zh` / `en`) |
| `+connect` | Inject Agent Skills into your local agent |

`--help` works at every level:

```shell
thcli --help
thcli plan --help
thcli plan key create --help
```

## Global Options

These options work with every command:

| Option | Description |
|---|---|
| `--profile <name>` | Account identity; determines which credentials to load |
| `--site <cn\|intl>` | Site |
| `--region <region>` | Cloud API region, e.g. `ap-guangzhou` |
| `--secret-id` / `--secret-key` | Temporarily override credentials; used as a pair |
| `--lang <zh\|en>` | Language for this invocation |

## Sites and Regions

The **site** (`cn` for China / `intl` for International) and the **region** (e.g. `ap-guangzhou`) together determine which set of resources you are operating on. Both affect every command — API keys, endpoints, plans, and usage are all isolated by site and region, so switching either one gives you a different set of resources.

### Set the site

```shell
thcli site list                  # List available sites
thcli site current               # Show the active site and its source
thcli site use --name cn         # Set as default (persists)
thcli models list --site intl    # Or specify for one invocation only
```

### Set the region

```shell
thcli profile set --region ap-guangzhou     # Set as default (persists)
thcli models list --region ap-singapore     # Or specify for one invocation only
```

The environment variable `TENCENTCLOUD_REGION` is also supported (lower priority than `--region`).

Priority: `--region` / `--site` > environment variable > saved default.

### Chat service endpoints

The endpoint `+chat` connects to varies by site and region:

| | Guangzhou | Singapore |
|---|---|---|
| China site `cn` | `tokenhub.tencentmaas.com` | `tokenhub-intl.tencentmaas.com` |
| International site `intl` | `tokenhub.tencentcloudmaas.com` | `tokenhub-intl.tencentcloudmaas.com` |

The main domain follows the site (`tencentmaas` / `tencentcloudmaas`), while the `-intl` suffix follows the region — so "China/Guangzhou" and "International/Guangzhou" are two different endpoints. Chat requests are authenticated with `Bearer <APIKey>`.

## Agent Integration

`+connect` downloads Agent Skills from the remote source into the local cache at `~/.thcli/skills-cache/`, then copies them into your local agent's skills directory. On its next launch, the agent can drive `thcli` in natural language ("which model is the cheapest?", "why is this key failing?").

```shell
thcli +connect             # Install / update: download to local cache + inject into agent (safe to re-run)
thcli +connect status      # Local version, remote version, cache contents, injected agents
thcli +connect uninstall   # Remove injected skills with the thcli- prefix
```

For agents without built-in support, specify the directory manually with `--target`:

```shell
thcli +connect --target ~/.some-agent/skills
```

`npm i -g` does **not** inject anything automatically, and it never touches your agent configuration. Run `thcli +connect` once when you want to enable it.

## Local Files

Everything lives under `~/.thcli/`:

| File | Permissions | Contents |
|---|---|---|
| `settings.json` | 0644 | Global settings: `profile` / `site` / `lang` |
| `{profile}.configure` | 0644 | The profile's `region` |
| `{profile}.{site}.credential` | 0600 | Account credentials + identity cache (site is part of the file name) |
| `{profile}.tokenhub.json` | 0600 | The API key used for conversations (site is in the file contents) |
| `config.json` | 0644 | Optional; partially overrides built-in infrastructure config, field by field |
| `log/` | 0600 | Call logs, see below |
| `skills-cache/` | 0644 | Cache of Agent Skills downloaded by `+connect` |

`{profile}.configure` is only created by `profile create` or `profile set --region`. It is perfectly normal for this file to be missing if you only use `auth login`; `region` falls back to the built-in default.

### Call logs

Under `~/.thcli/log/`, separated by profile, site, and channel:

| File | Contents |
|---|---|
| `{profile}.{site}.tokenhub-plugin-console.log` | Control plane: cloud API actions, request_id, latency, success/failure |
| `{profile}.{site}.tokenhub-plugin-chat.log` | Data plane: `+chat` model, channel, latency, success/failure |

Logs record call metadata only — they **never contain request parameters or response bodies**, and keys never end up in logs. A file rotates to a `.1` backup once it exceeds 5 MB; the old backup is overwritten by the next rotation. Log write failures never affect the command itself.

## Troubleshooting

Start with a health check:

```shell
thcli doctor                # End-to-end (same as thcli doctor all)
thcli doctor key --id <ak-xxx>   # Inspect a single key
thcli doctor error <code>   # Look up an error code
```

`doctor` is strictly read-only: it never changes any configuration and never incurs charges.

## Billing Notes

Commands that may incur charges prompt for confirmation by default: `plan buy` / `renew` / `upgrade`, `endpoint postpaid on`, and `deploy`. `+chat` is billed by token. All other commands are read-only queries.

## Requirements

Node.js >= 18.

## License

Apache-2.0
