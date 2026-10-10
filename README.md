# Pi intercom review pair

A Pi extension that pairs two already-running sessions as developer and reviewer without copying intercom UUIDs.

## Install

Install both packages, then restart Pi:

```bash
pi install npm:pi-intercom
pi install npm:pi-intercom-review-pair
```

No sandbox environment variables are required. If `PI_INTERCOM_SCOPE_ID` is configured, normal pi-intercom scope isolation still applies; otherwise the extension can discover any connected session that also has review-pair loaded.

## Use

From the session that should become the developer, run:

```text
/pair-review 999
```

Omit the issue number to enter it interactively. The session-name prefix comes from `--project <name>` when supplied; otherwise the command reads the repository name from the Git `origin` remote in the invoking session's working directory, falling back to a random common word when unavailable. It never asks for a project name or pull request. Without `--pr`, pairing starts a new review. The invoking session is always the developer. If exactly one other review-pair session is live, it becomes the reviewer automatically; otherwise the command asks you to select the reviewer by session name, working directory, model, status, and ID. In the TUI the picker is a full custom screen: one line per session, a viewport that scrolls with the terminal height, and up/down, page up/down, enter, and escape navigation.

Override the session-name prefix and declare an in-progress review with the optional flags:

```text
/pair-review 999 --project billing --pr 1234
```

`--project` skips Git detection and random selection entirely. The old positional project name remains supported for compatibility, but cannot be combined with `--project`.

`--pr` tells both roles the named pull request is already under review, so they read the current branch, existing comments, and open findings instead of starting the issue from scratch. The reference becomes part of the pairing identity: re-running with a different one re-briefs both sessions, and re-running with the same one stays idempotent.

After confirmation, the command assigns these names:

```text
<project>-<issue>
<project>-<issue>-review
```

Both targets receive self-contained role instructions identifying the issue and exact peer, without claiming that the session-name prefix is the actual project name. The developer asks the exact reviewer session to inspect a committed candidate, verifies findings, repairs valid ones, and repeats until the reviewer explicitly returns `No findings.` or requests a human decision.

When the work has a pull request, both roles post the full review request and findings there and send each other only the candidate SHA or verdict plus the comment URL over intercom. Without a pull request, intercom carries the full content.

## Process markers

Both role prompts end with a non-typable marker owned by this extension:

```text
⟦pi-intercom-review-pair:developer⟧
⟦pi-intercom-review-pair:reviewer⟧
```

`processMarker(role)` in `src/core.ts` produces them, so the exact characters should be matched through that function rather than retyped. The extension assigns the marker no meaning; a routing layer can match it in an injected prompt to run repository-specific process, for example loading a work-issue or review skill.

## Development

```bash
npm test
```

The three-session RPC smoke requires an already-running broker and a local pi-intercom entry point. It refuses to start another broker:

```bash
PI_INTERCOM_EXTENSION=/path/to/pi-intercom/index.ts npm run test:rpc
```

Both smokes load extensions with `--extension`/`-e`; no installation is required. The fake provider fixture uses the local Pi installation to avoid network model calls.
