**English** | [中文](./README.md)

# dsh-hydrasearch

Two free, barely-rate-limited web search backends for DeepSeek Harness.

Once installed, the built-in `web_search` / `web_fetch` gain a safety net: TinyFish and AnySearch stand by in order, and one takes over automatically when the other fails. Compatible with DSH 0.1.6-alpha.2 and 0.1.7-rc.1.

## Why use it

- **Both are free, with very high rate limits.** TinyFish and AnySearch both offer free usage that everyday searching and fetching will not exhaust. AnySearch does not even require a key up front — anonymous access works, at a lower quota.
- **Automatic failover between two backends.** If one times out, gets rate-limited, or errors out, the next one takes over, so a search never fails as a whole because of a single backend.

## Free quota and rate limits

| Backend | Cost | Rate limit |
| --- | --- | --- |
| TinyFish Search | Free, never draws from your balance | 30 requests/min · 500 requests/hour |
| TinyFish Fetch | Free, never draws from your balance | 150 URLs/min · 1,000 URLs/day |
| AnySearch (with key) | Free tier: 1,000 requests/day | 20 QPS |
| AnySearch (anonymous) | Shares the daily free quota | Rate-limited per client IP, lower than the above |

TinyFish Search and Fetch are free at any account balance and keep working at $0. AnySearch works without a key too, and a key raises it to the free tier. Figures come from the vendors' sites and may change; the official pages are authoritative.

## What it does

- **Search**: web search with language, region, date range, site allow/deny lists, and vertical-domain filters, plus control over how many pages each search may fetch.
- **Fetch**: turn a given URL into Markdown, HTML, or JSON, optionally returning the page's links and image links too.

## Installation

Add this repository with one command, then restart DSH: `dsh plugin --profile web add github:dgagf111/dsh-hydrasearch`

After the restart, open **Plugins page → Installed → `dsh-hydrasearch` → the row's configure entry**. On first use, enter a TinyFish key in the card; AnySearch can be left without one.

## Configuration

Everything happens in the `dsh-hydrasearch` card on the Plugins page:

- **Backend order**: drag to reorder; the topmost backend is tried first.
- **Failover**: on by default; turn it off and only the first available backend is used, whose failure is final.
- **Backend parameters**: search endpoint, language, region, date range, site filters, page count, fetch format, timeout, cache policy and more — fill in what you need, leave the rest blank to omit them.

## API keys and privacy

- **The key lives only in the credential center on your own machine** (DSH's local credentials file). It is never uploaded, never synced, and never written to logs.
- The plugin places the key in the request header sent to **the search service you are calling**, and to nothing else. There is no other recipient, and the plugin itself contains no telemetry or usage reporting.
- Read, write, and clear all target that same store.

## License

MIT
