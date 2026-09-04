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
/pair-review 999 billing
```

Omit the issue number to enter it interactively. Omit the project name to enter it interactively; leave that prompt blank to use a random common word. The invoking session is always the developer. If exactly one other review-pair session is live, it becomes the reviewer automatically; otherwise the command asks you to select the reviewer by session name, working directory, model, status, and ID.

After confirmation, the command assigns these names:

```text
<project>-<issue>
<project>-<issue>-review
```

Both targets receive self-contained role instructions. The developer asks the exact reviewer session to inspect a committed candidate, verifies findings, repairs valid ones, and repeats until the reviewer explicitly returns `No findings.` or requests a human decision.

## Development

```bash
npm test
```

The three-session RPC smoke requires an already-running broker and a local pi-intercom entry point. It refuses to start another broker:

```bash
PI_INTERCOM_EXTENSION=/path/to/pi-intercom/index.ts npm run test:rpc
```

Both smokes load extensions with `--extension`/`-e`; no installation is required. The fake provider fixture uses the local Pi installation to avoid network model calls.
