# GraphXRP

An Obsidian-style, interactive map of the XRP Ledger. Search for any account and walk through the ledger one hop at a time: who it pays, which tokens it holds, who created it, and who controls it. Every account that has a public identity shows its name, along with where that name came from.

It's built so a newcomer can look at the ledger directly, without having to trust anyone's summary of it.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (host it anywhere)
```

No backend and no API keys. The browser talks directly to public XRPL servers and identity directories.

Running it yourself (`npm run dev` or `npm run preview`) also turns on **Wallets**, a local wallet manager for testing (see below). The static build never includes it.

## What you can do

- **Explore.** Click an account to inspect it, double-click to expand its connections, hover to light up its neighborhood, drag to rearrange, and scroll to zoom. Right-click for more actions.
- **Trace origin.** Follow "who created this account?" back, hop by hop, until you reach a publicly identified account (often an exchange) or the start of ledger history.
- **Follow the money.** Repeatedly follow the biggest XRP source in each account's recent history. Dust payments are ignored.
- **Search** by name, website, address (`r…`) or transaction hash.
- **Read in plain English.** Activity reads like "Sent 50 XRP to Bitstamp (tag 123)". Account settings become traits such as *Blackholed: nobody controls it*, *Can claw back its tokens* or *Requires a destination tag*.
- **Filter like Obsidian.** Toggle account types and relationship types in the legend. Filter by currency, and tune display and forces (center, repel, link force, link distance) in Graph settings.
- **Add private labels and notes** to any account. They're stored only in your browser.
- **Share links.** The URL hash tracks the selected account (`#r…`, `#tx/<hash>`), and back/forward work.

## Cross-chain: bridges out of the XRP Ledger

The XRP Ledger's built-in bridge feature (XChainBridge) isn't enabled on mainnet, so every bridge is an outside operator running **door accounts** on the ledger. GraphXRP recognizes them and reads where deposits are headed:

| Bridge | How the destination is read | Links to |
|---|---|---|
| Axelar (gateway `rfmS3z…`) | Memos `destination_chain` + `destination_address` (gas fee split out) | The exact address on XRPL EVM, Ethereum, … |
| Coreum Bridge | JSON memo `{"type":"coreumbridge-xrpl-v1","coreum_recipient":"core1…"}` | The exact Coreum address |
| Wanchain (25 door accounts) | `CrossChainInfo` memo: type + token pair + 20-byte address + fee | The exact EVM address (chain set by the token pair) |
| Flare FAssets | `FBPRfA` payment reference: minting, redemption, … | The Flare network as a whole (no address in the memo) |
| Xahau Burn 2 Mint | `OperationLimit: 21337` on the burn transaction | The same account on Xahau |
| Allbridge, XAH Teleport, Orbit, XPR, Multichain | Recognized as doors; memos aren't readable destinations | Shown as bridge doors only |

On the map, **solid triangles** are bridge doors and **hollow triangles** are addresses (or whole chains) on networks GraphXRP can't read yet. They're connected by **"crossed to another chain"** lines. Payments whose memo names one bridge but went to an account that isn't one of that bridge's doors are flagged. Bridge housekeeping (operators moving funds between their own accounts) is labeled as such, not as user transfers.

## Connected networks: Xahau and the XRPL EVM Sidechain

Two more networks are read directly, so crossings to them can be **confirmed** rather than just declared:

| Network | Read through | Notes |
|---|---|---|
| Xahau | Its public servers (`wss://xahau.org`, `wss://xahau.network`), same protocol as the XRP Ledger | Same addresses as the XRP Ledger. The same r-address means the same master key, so names carry over and both sides are linked ("same keys on both networks"). |
| XRPL EVM Sidechain | Its public Blockscout explorer API (no key) | Wallets, smart contracts (pentagons) and tokens. Axelar messages are decoded in both directions. |

Each network gets its own **island** on the map: the XRP Ledger in the middle, connected networks to the right, unconnected chains (dashed outline) to the left. The legend's **Networks** section shows and hides islands. Search accepts `0x…` addresses (XRPL EVM) and offers "Same address on Xahau" for any r-address. Links look like `#xahau:r…` and `#xrpl-evm:0x…`.

**How crossings are confirmed** (dashed line = declared, solid = confirmed; each transaction shows a badge):

| Crossing | Confirmed when… | Strength |
|---|---|---|
| XRP Ledger → Xahau (Burn 2 Mint) | An Xahau Import contains this exact XRP Ledger transaction: hashing the embedded transaction gives the burn's ID | Cryptographic |
| Xahau Import → XRP Ledger | The XRP Ledger burn is recovered from the Import's proof | Cryptographic |
| XRP Ledger → XRPL EVM (Axelar) | A delivery to the named address whose Axelar message names this sender and the same amount | Decoded message |
| XRPL EVM → XRP Ledger (Axelar) | Axelar's gateway pays the named r-address the same amount afterwards | Matched payout |
| XAH Teleport (either way) | The same amount, to/from the same address, on the other network within 12 hours | Matched by address, amount and time |

A check that can't reach far enough back (for example a deposit to a very busy contract) says so rather than reporting "not found". Crossings to unconnected chains stay **declared**.

Door accounts that need a caution (Orbit's 2024 hack, Multichain's 2023 collapse) say so in the inspector.

## Your wallets (local only)

When GraphXRP runs on your machine, the **Wallets** button (or <kbd>W</kbd>) opens a drawer for the wallets you test with: Testnet, Devnet and Mainnet side by side.

- **Add.** Create wallets (named Alice, Bob, … and funded from the faucet), import a family seed, recovery phrase, Xaman secret numbers or a list of seeds, watch any address, or restore a backup. If XRPL Wallet Manager is running on port 7357, one click brings its wallets over.
- **See.** Balance and reserve, plain-English history that updates live, trust lines and tokens you issue, keys (hidden until revealed), and copy-paste snippets for xrpl.js, xrpl-py and `.env`.
- **Act.** Fund from the faucet, send XRP or tokens (checks for unactivated accounts, missing destination tags and missing trust lines first, with a one-click fix when the recipient is your wallet), add or remove trust lines, issue a token, and toggle *Require destination tags* or *Default ripple*.
- **Live.** When the app you're testing signs with one of these wallets, the balance and history update and a short notification says what happened.
- **On the map.** Your mainnet wallets show by name, search finds wallets by name, and the inspector marks accounts that are yours. Right-click any account to watch it.

**Where keys live.** Wallets are saved to `data/wallets.json` (git-ignored, file mode `0600`; override with `GRAPHXRP_WALLETS=/path/to/file.json`).

- Test-network keys are stored readable, so scripts can use them.
- **Mainnet keys are encrypted** in the browser with a vault password (PBKDF2-SHA256 with 600,000 rounds, then AES-GCM) before they're saved. The password is never stored. The vault locks after 15 idle minutes, and every mainnet transaction asks for confirmation first. The server refuses to save a readable mainnet secret, and **if you forget the password, those keys can't be recovered**, so keep your own backup of each seed.

**Use them from your scripts** while the dev server runs. The shape matches XRPL Wallet Manager's, so only the port changes:

```js
const w = await fetch('http://localhost:5173/api/wallets/alice').then((r) => r.json()) // label, address or id
const wallet = new Wallet(w.publicKey, w.privateKey)
const client = new Client(w.network.url)
```

`GET /api/wallets` lists them (filter with `?network=testnet`, `?group=…`, `?q=…`). Mainnet entries come back with `encrypted: true` and no secrets. The API answers only on this machine: loopback connections, a local `Host`, and pages served from `localhost`.

## Reading the map

| Shape | Account type | Color |
|---|---|---|
| Square | Exchange or service (requires destination tags) | orange |
| Diamond | Token issuer | blue |
| Hexagon | AMM liquidity pool | aqua |
| Circle | Wallet | gray |
| Solid triangle | Bridge door account | ink (white in dark mode) |
| Pentagon | Smart contract (XRPL EVM Sidechain) | gray |
| Hollow triangle | Address on a chain GraphXRP can't read yet | outline |
| Circle with `!` | Flagged by a public directory | red |
| Dashed ring | Inactive (deleted or never funded) | outline |

A ring around a shape means the account is publicly named. Faded shapes haven't been opened yet.

Lines: solid gray = **payments** (moving dots show direction), green = **created the account**, blue dotted = **holds tokens from** (points at the issuer), orange dashed = **traded with** (DEX/AMM), light dash-dot = **can sign for** (regular key or multisig), long white dashes = **crossed to another chain** (solid once confirmed), short gray dots = **used a smart contract**.

The palette is validated for color-vision deficiency. Shape and dash pattern repeat the color information, so color is never the only cue.

## Where the data comes from

| What | Source | Trust |
|---|---|---|
| Balances, settings, trust lines, history, AMM pools | Public XRPL servers over WebSocket (`xrplcluster.com`, `s1`/`s2.ripple.com`, `xrpl.ws`) | Ledger facts |
| Names of ~2,800 known accounts, scam/hack advisories | XRPScan public API (cached for 24h) | Directory claim |
| Per-account aliases, KYC status, avatars | Xaman account-meta API (also relays Bithomp names) | Directory claim |
| Website ownership | The account's on-ledger `Domain`, checked against `https://<domain>/.well-known/xrp-ledger.toml` | Two-way proof when it matches |

The inspector lists every name claim with its source. A website counts as **confirmed** only when the site lists the account back in its TOML file. Many sites block cross-origin requests, and the UI says so ("couldn't check") instead of guessing.

## Project layout

```
src/
  xrpl/client.ts       WebSocket client: failover, request queue, rate-limit backoff, live ledger stream
  xrpl/loader.ts       account data (info, lines, history, activation, issued totals, AMM) + caching
  xrpl/parse.ts        transactions -> graph flows + plain-English sentences
  xrpl/flags.ts        account flags -> human traits (blackholed, clawback, multisig, ...)
  xrpl/amount.ts       amounts, currency-code decoding, formatting
  bridges/registry.ts  known bridge doors, chain names, explorer links, other-chain node IDs
  bridges/decode.ts    memo decoders for Axelar, Coreum, Wanchain, Flare FAssets, Burn 2 Mint, XAH Teleport
  bridges/verify.ts    confirms crossings on the destination network
  chains/chains.ts     networks, graph ids per network, Xahau Import proof hashing
  chains/evm.ts        XRPL EVM Sidechain via Blockscout, Axelar ITS payload decoding
  identity/directory.ts  names, advisories, domain verification, your labels
  graph/model.ts       nodes + aggregated, de-duplicated edges
  graph/view.ts        canvas renderer, d3-force physics, pointer/zoom interaction
  app.ts               controller: explore, expand, trace, classify, navigation
  ui/                  inspector, search/top bar, legend & settings, overlays
  wallets/             local wallet manager (loaded only when the wallet API answers): store, vault, keys, ledger, UI
server/
  walletApi.ts         the local wallet API, mounted into the Vite dev/preview server
```

## Limits and notes

- Expanding an account reads its latest 200 transactions ("Load older history" pages further back). Its connections are ranked by value moved and capped by *Connections per expand* (default 40).
- Public servers rate-limit heavy use. The client parks a throttled server and fails over to the next one automatically. You can point it at your own node in Graph settings → Ledger server.
- X-addresses aren't supported yet. Use the classic `r…` address.
- In development, `window.app` exposes the controller for poking around in the console.
